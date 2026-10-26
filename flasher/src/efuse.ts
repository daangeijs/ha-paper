// ESP32-S3 security eFuses, read as raw registers with ESPLoader.readReg().
//
// Addresses and masks are copied from esptool (Python) v5.5.0, esptool/targets/esp32s3.py, class ESP32S3ROM:
//   EFUSE_BASE                    = 0x60007000
//   EFUSE_SPI_BOOT_CRYPT_CNT_REG  = EFUSE_BASE + 0x034,  EFUSE_SPI_BOOT_CRYPT_CNT_MASK = 0x7 << 18
//   EFUSE_SECURE_BOOT_EN_REG      = EFUSE_BASE + 0x038,  EFUSE_SECURE_BOOT_EN_MASK     = 1 << 20
// (0x034 / 0x038 are EFUSE_RD_REPEAT_DATA1_REG / EFUSE_RD_REPEAT_DATA2_REG: the BLOCK0 read-back words.)
// Flash encryption is on when SPI_BOOT_CRYPT_CNT has an odd number of bits set; esptool cmds.py tests
// `bin(flash_crypt_cnt).count("1") & 1 != 0`. esptool-js 0.7.0 uses the same EFUSE_BASE (targets/esp32s3.js).

export const EFUSE_BASE = 0x60007000;
export const EFUSE_SPI_BOOT_CRYPT_CNT_REG = EFUSE_BASE + 0x034;
export const EFUSE_SPI_BOOT_CRYPT_CNT_SHIFT = 18;
export const EFUSE_SPI_BOOT_CRYPT_CNT_MASK = 0x7 << EFUSE_SPI_BOOT_CRYPT_CNT_SHIFT;
export const EFUSE_SECURE_BOOT_EN_REG = EFUSE_BASE + 0x038;
export const EFUSE_SECURE_BOOT_EN_MASK = 1 << 20;

export interface SecurityState {
  secureBoot: boolean;
  flashCryptCnt: number;
  flashEncryption: boolean;
}

export function popcount(n: number): number {
  let c = 0;
  for (let v = n >>> 0; v; v >>>= 1) c += v & 1;
  return c;
}

/** Decode the two BLOCK0 words. `cryptWord` = value at 0x60007034, `secureBootWord` = value at 0x60007038. */
export function decodeSecurity(cryptWord: number, secureBootWord: number): SecurityState {
  const flashCryptCnt = ((cryptWord >>> 0) & EFUSE_SPI_BOOT_CRYPT_CNT_MASK) >>> EFUSE_SPI_BOOT_CRYPT_CNT_SHIFT;
  return {
    secureBoot: ((secureBootWord >>> 0) & EFUSE_SECURE_BOOT_EN_MASK) !== 0,
    flashCryptCnt,
    flashEncryption: popcount(flashCryptCnt) % 2 === 1,
  };
}

export interface RegReader {
  readReg(addr: number): Promise<number>;
}

export async function readSecurity(loader: RegReader): Promise<SecurityState> {
  const cryptWord = await loader.readReg(EFUSE_SPI_BOOT_CRYPT_CNT_REG);
  const secureBootWord = await loader.readReg(EFUSE_SECURE_BOOT_EN_REG);
  if (!Number.isInteger(cryptWord) || !Number.isInteger(secureBootWord)) {
    throw new Error("eFuse read returned no value");
  }
  return decodeSecurity(cryptWord, secureBootWord);
}
