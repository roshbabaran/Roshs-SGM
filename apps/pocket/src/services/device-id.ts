/**
 * This phone's Device ID, which the owner approves once on the server. It has
 * to stay the same through every update, or the phone needs approving again.
 *
 * It is kept in two places, the phone's secure storage and a file in the app's
 * own folder, so losing one (Android can drop secure storage's key) doesn't
 * lose the ID. An ID made on a phone that has neither comes from the phone's
 * Android ID, which stays the same for SGM Pocket even after it is uninstalled
 * and installed again, so a reinstall gets the same ID back too.
 */
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const DEVICE_KEY = 'sgm.device-id';
const VALID = /^[A-Za-z0-9-]{8,64}$/;

const file = () => new File(Paths.document, 'device-id.txt');

async function fromSecureStore(): Promise<string | null> {
  try {
    const id = (await SecureStore.getItemAsync(DEVICE_KEY))?.trim();
    return id && VALID.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function fromFile(): Promise<string | null> {
  try {
    const saved = file();
    if (!saved.exists) return null;
    const id = (await saved.text()).trim();
    return VALID.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function saveEverywhere(id: string, inSecureStore: string | null, inFile: string | null): Promise<void> {
  if (inSecureStore !== id) await SecureStore.setItemAsync(DEVICE_KEY, id).catch(() => undefined);
  if (inFile !== id) {
    try {
      const saved = file();
      if (!saved.exists) saved.create();
      saved.write(id);
    } catch {
      // Secure storage still has it.
    }
  }
}

/** A UUID made from the phone's own ID, so the same phone always gets the same one. */
async function fromPhone(): Promise<string | null> {
  let source: string | null = null;
  try {
    source = Platform.OS === 'android' ? Application.getAndroidId() : await Application.getIosIdForVendorAsync();
  } catch {
    return null;
  }
  if (!source) return null;
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `sgm-pocket-device:${source}`);
  // Laid out like a version 5 UUID, the same shape as the IDs made at random.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function loadDeviceId(): Promise<string> {
  const [inSecureStore, inFile] = await Promise.all([fromSecureStore(), fromFile()]);
  // Secure storage first: it is where every ID before 1.1.1 was kept, so phones keep the ID already approved.
  const id = inSecureStore ?? inFile ?? (await fromPhone()) ?? Crypto.randomUUID();
  await saveEverywhere(id, inSecureStore, inFile);
  return id;
}
