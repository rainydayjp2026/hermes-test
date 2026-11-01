import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import Constants from 'expo-constants';

type ScanResult = {
  has_text: boolean;
  text: string;
  title: string;
  saved: { image_id: string; text_id: string } | null;
};

type State =
  | { kind: 'idle' }
  | { kind: 'sending'; uri: string }
  | { kind: 'done'; uri: string; result: ScanResult }
  | { kind: 'error'; uri: string; base64: string; message: string };

const extra = (Constants.expoConfig?.extra ?? {}) as {
  workerUrl?: string;
  appToken?: string;
};
const MAX_EDGE = 1600;

let consentGiven = false;

function askConsent(): Promise<boolean> {
  if (consentGiven) return Promise.resolve(true);
  return new Promise((resolve) => {
    Alert.alert(
      '送信の確認',
      '撮影した画像を Google Gemini に送信して文字を解析し、文字が含まれていれば画像とテキストを Google ドライブの共有ドライブに保存します。',
      [
        { text: 'キャンセル', style: 'cancel', onPress: () => resolve(false) },
        {
          text: '同意する',
          onPress: () => {
            consentGiven = true;
            resolve(true);
          },
        },
      ],
    );
  });
}

async function shrink(asset: ImagePicker.ImagePickerAsset): Promise<string> {
  const ctx = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > MAX_EDGE) {
    ctx.resize(asset.width >= asset.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
  }
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
  if (!out.base64) throw new Error('画像の変換に失敗しました');
  return out.base64;
}

async function postScan(base64: string): Promise<ScanResult> {
  if (!extra.workerUrl || !extra.appToken) {
    throw new Error('app.json の extra.workerUrl / extra.appToken が未設定です');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${extra.workerUrl.replace(/\/$/, '')}/scan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${extra.appToken}`,
      },
      body: JSON.stringify({ image_base64: base64, mime_type: 'image/jpeg' }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body as ScanResult;
  } finally {
    clearTimeout(timer);
  }
}

export default function App() {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const send = async (uri: string, base64: string) => {
    setState({ kind: 'sending', uri });
    try {
      const result = await postScan(base64);
      setState({ kind: 'done', uri, result });
    } catch (e) {
      const message =
        e instanceof Error && e.name === 'AbortError'
          ? 'タイムアウトしました'
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', uri, base64, message });
    }
  };

  const capture = async () => {
    if (!(await askConsent())) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('カメラの権限が必要です', '設定アプリからカメラへのアクセスを許可してください。');
      return;
    }
    const picked = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
    if (picked.canceled || !picked.assets?.[0]) return;
    const asset = picked.assets[0];
    try {
      const base64 = await shrink(asset);
      await send(asset.uri, base64);
    } catch (e) {
      setState({ kind: 'error', uri: asset.uri, base64: '', message: String(e) });
    }
  };

  const busy = state.kind === 'sending';

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <Text style={styles.title}>OCR Inbox</Text>

      <Pressable
        style={[styles.button, busy && styles.buttonDisabled]}
        onPress={capture}
        disabled={busy}
      >
        <Text style={styles.buttonText}>撮影する</Text>
      </Pressable>

      {state.kind !== 'idle' && (
        <Image source={{ uri: state.uri }} style={styles.preview} resizeMode="contain" />
      )}

      {state.kind === 'sending' && (
        <View style={styles.row}>
          <ActivityIndicator />
          <Text style={styles.muted}>解析・保存中…</Text>
        </View>
      )}

      {state.kind === 'error' && (
        <View style={styles.box}>
          <Text style={styles.error}>エラー: {state.message}</Text>
          {state.base64 !== '' && (
            <Pressable style={styles.smallButton} onPress={() => send(state.uri, state.base64)}>
              <Text style={styles.buttonText}>再送する</Text>
            </Pressable>
          )}
        </View>
      )}

      {state.kind === 'done' && !state.result.has_text && (
        <Text style={styles.muted}>文字は検出されませんでした（保存していません）</Text>
      )}

      {state.kind === 'done' && state.result.has_text && (
        <View style={[styles.box, styles.flex]}>
          <Text style={styles.ok}>
            {state.result.saved ? 'ドライブに保存しました' : '保存されていません'}：{state.result.title}
          </Text>
          <ScrollView style={styles.flex}>
            <Text selectable style={styles.text}>
              {state.result.text}
            </Text>
          </ScrollView>
          <Pressable
            style={styles.smallButton}
            onPress={() => Clipboard.setStringAsync(state.result.text)}
          >
            <Text style={styles.buttonText}>テキストをコピー</Text>
          </Pressable>
          <Text style={styles.note}>AIによる書き起こしのため誤りを含む可能性があります。</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 16, paddingTop: 56, gap: 12 },
  title: { fontSize: 22, fontWeight: '700' },
  button: { backgroundColor: '#1a73e8', padding: 16, borderRadius: 8, alignItems: 'center' },
  buttonDisabled: { opacity: 0.5 },
  smallButton: { backgroundColor: '#1a73e8', padding: 10, borderRadius: 6, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  preview: { width: '100%', height: 180, backgroundColor: '#eee' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  box: { gap: 8 },
  flex: { flex: 1 },
  muted: { color: '#666' },
  error: { color: '#c5221f' },
  ok: { color: '#188038', fontWeight: '600' },
  text: { fontSize: 15, lineHeight: 22 },
  note: { color: '#888', fontSize: 12 },
});
