import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { config } from "../../config.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { getSettingsMap } from "../settings.service.js";
import { parseDirectActionTemplate, type DirectActionTemplate, type DirectTemplateParams } from "./direct-template.js";
import { parseSmsPush, type ParsedSmsPush } from "./message-parser.js";
import type {
  DingtoneGateway,
  DingtoneLoginInput,
  DingtoneLoginResult,
  DingtonePhonePurchaseCandidate,
  DingtonePhonePurchasePreview,
  DingtonePhoneCountryOption,
  DingtoneSessionExportInput,
  DingtoneSessionExport,
  DingtonePhoneNumber,
  DingtoneSnapshot,
  VerificationRequestResult
} from "./types.js";

type DirectRuntimeConfig = {
  primaryHost: string;
  backupHost: string;
  port: number;
  connectTimeoutMs: number;
  ioTimeoutMs: number;
  useTls: boolean;
  appVersion: string;
  apkCertificateSign: string;
  listenHostConcurrency: number;
};

type ParsedFrame = {
  raw: Buffer;
  type: number;
  session: Buffer;
  status?: number;
  route?: Buffer;
  body: Buffer;
};

type ApiResult = Record<string, unknown>;
type PrivatePhoneRequestConfig = {
  countryKey: string;
  label: string;
  countryCode: number;
  isoCountryCode: string;
  providerIdList: string[];
  packageServiceId?: string;
  applyType?: number;
  randomAreaCodes?: number[];
};
type PrivatePhoneRequestQueryOptions = {
  apiVersion?: number;
  providerKey?: "providerList" | "providerIdList";
  providerIdList?: string[];
  areaCode?: number | null;
  includeAppContext?: boolean;
  includeAppRequestFields?: boolean;
  includeZeroAreaCode?: boolean;
  leadingAmpersand?: boolean;
};
type DirectPhoneActionContext = Partial<DingtonePhoneNumber> &
  Partial<DingtonePhonePurchaseCandidate> & {
    rawJson?: string;
    category?: number;
    phoneType?: number;
  };
type DirectSessionAccount = {
  dtUserId: string;
  token: string;
  deviceId?: string | null;
  email?: string | null;
};
type DirectPhoneTemplateSettingKey =
  | "dt_direct_template_request_phone"
  | "dt_direct_template_purchase_phone"
  | "dt_direct_template_renew_phone"
  | "dt_direct_template_cancel_phone"
  | "dt_direct_template_pause_phone"
  | "dt_direct_template_resume_phone"
  | "dt_direct_template_phone_setting";
type DirectTemplateSettingKey = DirectPhoneTemplateSettingKey | "dt_direct_template_offline_messages";

export type DirectProbeCustomTemplate = {
  name: string;
  hex: string;
  params?: DirectTemplateParams;
};

export type DirectProbeCallResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  payload?: ApiResult;
  error?: string;
  frames?: DirectProbeFrameTrace[];
};

export type DirectProbePushResult = {
  receivedAt: string;
  frameType: number;
  status?: number;
  routeHex?: string;
  bodyLength: number;
  rawHex?: string;
  bodyHex?: string;
  rawHexPreview: string;
  bodyHexPreview?: string;
  jsonPayload?: ApiResult | null;
  sms?: ParsedSmsPush | null;
};

export type DirectProbeResult = {
  ok: boolean;
  host: string;
  dtUserId: string;
  deviceId?: string | null;
  calls: DirectProbeCallResult[];
  pushes: DirectProbePushResult[];
  trace?: DirectProbeFrameTrace[];
  offlineTemplateAttempted?: boolean;
  offlineTemplateSent?: boolean;
  offlineTemplateError?: string | null;
  preempted?: boolean;
};
export type DirectAccessCodeProbeResult = {
  ok: boolean;
  host: string;
  dtUserId: string;
  deviceId?: string | null;
  capability: DirectAccessCodeProbeCapability;
  recoverPassword?: DirectProbeCallResult;
  verifyAccessCode?: DirectProbeCallResult;
  trace?: DirectProbeFrameTrace[];
};

export type DirectAccessCodeProbeCapability = typeof ACCESS_CODE_PROBE_CAPABILITY;

export type DirectAccessCodeDryRun = {
  capability: DirectAccessCodeProbeCapability;
  kind: "email" | "phone";
  target: string;
  countryCode: number;
  recoverPassword: {
    apiName: "recoverPassword";
    query: string;
    params: Record<string, string>;
  };
  verifyAccessCode?: {
    apiName: "verifyAccessCode";
    query: string;
    params: Record<string, string>;
  };
};

export type DirectProbeFrameTrace = {
  receivedAt: string;
  frameType: number;
  status?: number;
  routeHex?: string;
  rawLength: number;
  bodyLength: number;
  rawHexPreview: string;
  bodyHexPreview: string;
  jsonPayload?: ApiResult | null;
};

export type DirectPhoneActionDryRun = {
  label: DirectPhoneActionLabel;
  apiName: string;
  query: string;
  params: Record<string, string>;
};

type DirectPhoneActionLabel =
  | "purchasePhone"
  | "renewPhone"
  | "cancelPhone"
  | "pausePhone"
  | "resumePhone"
  | "updatePhoneLabel"
  | "clearPhoneLabel";

type ActiveDirectPushListener = {
  key: string;
  preempted: boolean;
  session?: DirectSession;
  sessions?: Set<DirectSession>;
};

const CONNECT_REQUEST = Buffer.from("01070000000e820100000000c88d", "hex");
const MAX_DIRECT_TRACE_FRAMES = 80;
const APP_DIRECT_PUSH_HOSTS = [
  "13.232.238.50",
  // Observed in TalkU foreground RTC/SMS captures and queryRtcServersEx responses.
  "13.115.134.59",
  "18.163.19.61",
  "18.167.61.229",
  "18.167.142.247",
  "18.167.161.7",
  "18.167.7.142",
  "34.247.151.224",
  "3.24.58.244",
  "3.1.42.208",
  "54.179.68.57",
  "165.227.7.100",
  "4.151.48.9",
  "18.229.197.6",
  "18.228.217.199",
  "46.137.56.62",
  "65.1.82.252",
  "65.2.18.189",
  "68.183.40.1",
  "18.167.22.30",
  "47.103.128.70",
  "101.133.141.94"
];
const TALKU_APP_ID = "me.talkyou.app.im";
const DINGTONE_APP_ID = "me.dingtone.app.im";
const TALKU_APK_CERTIFICATE_SIGN = "bf6bf7a31a53d5c06dd1c7d03fd3d917";
const TALKU_DIRECT_API_CERTIFICATE_SIGN = "458cf4f3e576f61a26187d218e4af9d3";
const CAPTURED_OFFLINE_FIELDS = {
  deviceId: "And.11111111111111111111111111111111.dttalk"
} as const;
const activeDirectPushListeners = new Map<string, ActiveDirectPushListener>();
const directSessionOperationLocks = new Map<string, Promise<void>>();
const directAccountPhoneCountryKeyCache = new Map<string, Set<string>>();
const LOGIN_INIT_PACKET = Buffer.from(
  "010700000399810727c6004700000389010200000389d33d000300502788000000000000000108010000000001000000010000001764332e33642e30302e30332e30302e35302e32372e38380000001730302e30302e30302e30302e30302e30302e30302e3031000000090000032a0000002b416e642e30303030303030303030303030303030303030303030303030303030303030302e647474616c6b0000000f3130303030303030303030303030300000002030303030303030303030303030303030303030303030303030303030303030300000000932303334303431393700000016706c616365686f6c646572406578616d706c652e696fd33d0003005027880000000002000000117b227374617475734f6666223a2230227d0000027764657669636549643d416e642e30303030303030303030303030303030303030303030303030303030303030302e647474616c6b267573657249643d31303030303030303030303030303026746f6b656e3d3030303030303030303030303030303030303030303030303030303030303030266d616769633d35343037372677536974653d33266477486f73743d3532353330303026616464724368616e67653d3026547261636b436f64653d343030353131383533303132393130313126634150494c6576656c3d31264c433d7a68266a736f6e3d253762253232436c69656e7456657273696f6e2532322533612d31363130323138373531253263253232436f6e6e65637456657273696f6e253232253361313638343533313425326325323250726573656e63654d6573736167652532322533612532322537622535632532327374617475734f66662535632532322533612535632532323025356325323225376425323225326325323250726573656e63655374617475732532322533613225326325323274696d657a6f6e65253232253361253232474d542532623038253361303025323225376426636c69656e74496e666f3d25376225323270696e6754696d65253232253361253232313030303030253362313030303030253232253263253232636f6e6e65637465645625323225336130253263253232686173562532322533613025326325323261707049642532322533612532326d652e74616c6b796f752e6170702e696d2532322532632532327369676e4d643525323225336125323263333830656335626638383731626164646133383764343137396262376134312532322537642641736b41636b3d310107000000fa810727c60047000000ea0102000000ead33d000300502788000000000000000101010000000001000000020000001764332e33642e30302e30332e30302e35302e32372e38380000001730302e30302e30302e30302e30302e30302e30302e3031000000080000008b0000000000000012676574496e666f4265666f72654c6f67696e0000006600000065789c0dccb10a84300c00d0bfe9589268aeedd0419cdce5f6d0e4a02855b4dcf7ebf2c6a7f6afc516cd53531fc9e49388852c618c2fe9c71858690802685e7b977d73eb25659b0fb53c023062e4019012230427e7f96eaeecd55affda75d7a3e5071a051edd00000000",
  "hex"
);

const CAPTURED_LOGIN_FIELDS = {
  deviceId: "And.00000000000000000000000000000000.dttalk",
  userId: "100000000000000",
  token: "00000000000000000000000000000000",
  email: "placeholder@example.io"
} as const;

export const ACCESS_CODE_PROBE_CAPABILITY = {
  mode: "probe_only",
  verifiedCalls: ["recoverPassword", "verifyAccessCode"],
  loginTokenCompleted: false,
  requiresExternalCaptureForLoginToken: true,
  note: "This probe validates the recoverPassword/verifyAccessCode request path only; it does not complete first-login token creation."
} as const;

const TEMPLATES = {
  getInfoBeforeLogin: Buffer.from(
    "0107000000bf810727c60047000000af0101000000af0000000000000000000000000000000100010001000001010040101a00000000000000000000000000000000000000000000000000000000000000687b226465766963654944223a22416e642e30303030303030303030303030303030303030303030303030303030303030302e647474616c6b222c226e6f745072654c6f67696e223a2274727565222c22757365724944223a3130303030303030303030303030307d0000000000",
    "hex"
  ),
  getBalance: Buffer.from(
    "010700000148810727c6004700000138010200000138d33d0003005027880000000000000001010100000000010000001a0000001764332e33642e30302e30332e30302e35302e32372e38380000001730302e30302e30302e30302e30302e30302e30302e303100000008000000d900000001320000001762696c6c696e672f757365722f67657442616c616e6365000000d4000000ad789c0d8eb18e03210c44ff8672651b6ca0d8224a95faa2f43e3027b4d16eb4e1f2fda199629ee669aa7d7ab15b5d2f7b5d12994a2656b28c29cdc88d3172251f15d0963a863e37773fb56cd7a3da1a001831b1070c0c91d9397dbd1e76befbb1afb2f80567b15ded1cbdf5a2c37efadfbe9606d92b98fc42acc57c4906dc620d9a0b0916f7ffb6739e9a52f4c95326c8c1a31bc766734d162446c9d9071299a44464a2a4d8c89a7c0145da3d8b00000000",
    "hex"
  ),
  getPrivateNumber: Buffer.from(
    "010700000152810727c6004700000142010200000142d33d0003005027880000000000000001010100000000010000001c0000001764332e33642e30302e30332e30302e35302e32372e38380000001730302e30302e30302e30302e30302e30302e30302e303100000008000000e300000001320000001c2f7073746e2f73686172652f676574507269766174654e756d626572000000e7000000b2789c5d8e3d6fc3300c44ff8d464324f5c5c1439029738bee2c45058203db70d4fefe6aee72c33d1cde55fbed6a8fbadef6ba1434498c51d0184a99c12d428e15298b075bea18f2dadce725badd8f6a6bf03e0294481e422c1cb2d357b77d7cd9f5eec7bea6851670729eff8bed6ed7e8adab0cfbe8cf7dd5e699c45bfaf6b9aa9116f3b1e51a841513a8fb79db357f4e0f502164f41c08dc38369b6bb490724ecc1430a5493443442c020dada53faa1b442e00000000",
    "hex"
  ),
  getUserSetting: Buffer.from(
    "01070000014c810727c600470000013c01020000013cd33d000300502788000000000000000101010000000001000000140000001764332e33642e30302e30332e30302e35302e32372e38380000001730302e30302e30302e30302e30302e30302e30302e303100000008000000dd0000000132000000137073746e2f6765745573657253657474696e67000000f1000000b5789c6d8eb16ec3300c44ff46a3219212250d1e8a4c999b766729aa101cd881a3e6fbabee5d6eb8c37bb86aafae76adebdb5e978c265c300a5a819c67941621c58a94c4832d750cb96fee768a6e97a3da1abc8f003992072a14009cd37bb77d7c3ced9c560811281316f4251038793c3eed7cf6635f79a1e5afd82e768edebacab0f7febdafda7c21f1c65f3e5535d26c3eb65483144506753fffbbc7b1d9a4d102a7c465de41e6b968828898051a5ae35f9ba645bb00000000",
    "hex"
  ),
  requestAllOfflineMessage: Buffer.from(
    "0107000000ab81074bd2003b0000009b01020000009be3af000300504b0f00000003005000010c070000000001000000060000001765332e61662e30302e30332e30302e35302e34622e30660000001730302e30302e30302e30332e30302e35302e30302e3031000000150000003c000000002b416e642e31313131313131313131313131313131313131313131313131313131313131312e647474616c6b000000000000000000000000",
    "hex"
  ),
  followerListInfo: Buffer.from(
    "01070000010f8107c7d8001c000000ff0102000000fff6e7000c02412950000000000000000101010000000001000004460000001766362e65372e30302e30632e30322e34312e32392e35300000001730302e30302e30302e30302e30302e30302e30302e303100000008000000a0000000013200000010466f6c6c6f7765724c697374496e666f0000008e0000007b789c0dcb310ec2300c00c0df74acecd871eca1036262e703716c2454d44aa5f07eb8fd22bfcf91b7582e5bcc15c8cd5d5d3944d25435fde1a0a3942614739c677fadd3e79dc7bf205724a562058c09a7735f735b841c4758e712d16180097668cede85238ca6fbd1c77add231706a8885acda4a182951fddcd28d900000000",
    "hex"
  ),
  getFriendList: Buffer.from(
    "0107000001188107c7d8001c00000108010200000108f6e7000c02412950000000000000000101010000000001000004470000001766362e65372e30302e30632e30322e34312e32392e35300000001730302e30302e30302e30302e30302e30302e30302e303100000008000000a900000001320000000d676574667269656e646c6973740000009d00000087789c0dcc3b0ec2300c00d0db64acec7c5c7bc88098d818b8401c1b0915a5521b383fbc033cf3efabfbcdea65d85220a9a8b27236221766767d2a708f71a5648bcdd9de5b98fbe6a35252ec262d47b3061d84b0c1aa591b653349e173faf19f31174c9ca244909c300c77bb1f7efae85e313c8ed6b7eb6e5e334041e422426b8cc8fc03be632e3f00000000",
    "hex"
  ),
  infoBus: Buffer.from(
    "0107000001608107c7d8001c00000150010200000150f6e7000c02412950000000000000000101010000000001000004480000001766362e65372e30302e30632e30322e34312e32392e35300000001730302e30302e30302e30302e30302e30302e30302e303100000008000000f100000001320000000c7073746e2f696e666f42757300000114000000d0789c5dce316bc3301086e17fa3d1e8a493741a3c944c5d42a121bba43b15e1d4368a92fcfd7a2814babe7c3c7c2ccf56e49de7b79527a76d8e39532664ef251291e49a35156382b73cf118e9b6a84b4f65396d2c336aed00c8c5e883f18650a955c66bebcb417e9c41955b93753ca5dfdbb6ce7eb213a8b4b7eb6f30aa7691f3e3fb2fa47dbffe9b2f27e9a3d556d290cff6b5cee8a854ac565cf0d543321e28b001124c35b2558fbbf4e301a0034bd644a3235a50635be4606d86c231a1614ebae878083a64ccc92373b43f1158558000000000",
    "hex"
  ),
  queryRtcServersEx: Buffer.from(
    "0107000000f98107c7d8001c000000e90102000000e9f6e7000c024129500000000000000001010100000000010000044c0000001766362e65372e30302e30632e30322e34312e32392e35300000001730302e30302e30302e30302e30302e30302e30302e3031000000080000008a000000105f5f454447455f505249564154455f5f0000001471756572795f7274635f736572766572735f65780000004d00000052789c2b4e2d2ececccf8bcf4cb13550cb2cce4fce2fcd2b29aab475f603f18a4b124b526d3d52f312f3d4d27212d38b6d2dd5428a1293b39df353526d4d0c0c4c0d0d2d4c2d2dcdcc8d2d4ccd8d004d0e19a600000000",
    "hex"
  ),
  updateClientLink: Buffer.from(
    "0107000001528107c7d8001c00000142010200000142f6e7000c024129500000000000000001010100000000010000044e0000001766362e65372e30302e30632e30322e34312e32392e35300000001730302e30302e30302e30302e30302e30302e30302e303100000008000000e3000000013200000010757064617465636c69656e746c696e6b000000f0000000be789c0dceb16ec5200c40d1bf6144361863860cd59bdedcaa3b6053a15449949756fdfc66bdc3d155fb9ddd9ebabc6dea13c4565a9326a4cc5644c4da68203d84cc51bd5e57fd5eddc759fbfad8d516024888924ae14c9c999cfb9bc732d85bf6001eba87e0097d28b7eeea717cdaf99afbb6b08f1eefb03eecbce698bd5ef63ebfb68592f441235aca3c186b6094ac01c5a88ea2d1fdbcecbc8791124689a1042814d15dfb6a371b1b762d95826a850ee51620376a9549b5c47f12d4457400000000",
    "hex"
  )
} as const;

const APP_PHONE_COUNTRY_CONFIGS: PrivatePhoneRequestConfig[] = [
  { countryKey: "US", label: "美国 +1", countryCode: 1, isoCountryCode: "US", providerIdList: ["2000", "2001"], packageServiceId: "DT01001", applyType: 1, randomAreaCodes: [213, 646, 312, 415, 305, 212, 323, 424, 469, 512, 628, 702, 786, 929, 971] },
  { countryKey: "CA", label: "加拿大 +1", countryCode: 1, isoCountryCode: "CA", providerIdList: ["2000", "2001"], packageServiceId: "DT02002", applyType: 2, randomAreaCodes: [416, 647, 437, 604, 778, 236, 514, 438, 613, 343] },
  { countryKey: "GB", label: "英国 +44", countryCode: 44, isoCountryCode: "GB", providerIdList: ["2001", "2007"], packageServiceId: "DT02001", applyType: 3 },
  { countryKey: "BE", label: "比利时 +32", countryCode: 32, isoCountryCode: "BE", providerIdList: ["2002"], packageServiceId: "DT03001", applyType: 5 },
  { countryKey: "NL", label: "荷兰 +31", countryCode: 31, isoCountryCode: "NL", providerIdList: ["2006"], packageServiceId: "DT03005", applyType: 9 },
  { countryKey: "RU", label: "俄罗斯 +7", countryCode: 7, isoCountryCode: "RU", providerIdList: ["2003"], packageServiceId: "DT03002", applyType: 6 },
  { countryKey: "ES", label: "西班牙 +34", countryCode: 34, isoCountryCode: "ES", providerIdList: ["2004"], packageServiceId: "DT03003", applyType: 7 },
  { countryKey: "CN", label: "中国 +86", countryCode: 86, isoCountryCode: "CN", providerIdList: ["2030"], packageServiceId: "DT04001", applyType: 11 },
  { countryKey: "AU", label: "澳大利亚 +61", countryCode: 61, isoCountryCode: "AU", providerIdList: ["2008"], packageServiceId: "DT03007", applyType: 13 },
  { countryKey: "AT", label: "奥地利 +43", countryCode: 43, isoCountryCode: "AT", providerIdList: ["2100"], packageServiceId: "DT03008", applyType: 14 },
  { countryKey: "FR", label: "法国 +33", countryCode: 33, isoCountryCode: "FR", providerIdList: ["2100"], packageServiceId: "DT03009", applyType: 15 },
  { countryKey: "SE", label: "瑞典 +46", countryCode: 46, isoCountryCode: "SE", providerIdList: ["2100"], packageServiceId: "DT03010", applyType: 16 },
  { countryKey: "MU", label: "毛里求斯 +230", countryCode: 230, isoCountryCode: "MU", providerIdList: ["2100"], packageServiceId: "DT03011", applyType: 17 },
  { countryKey: "PL", label: "波兰 +48", countryCode: 48, isoCountryCode: "PL", providerIdList: ["2300"], packageServiceId: "DT05003", applyType: 18 },
  { countryKey: "ID", label: "印度尼西亚 +62", countryCode: 62, isoCountryCode: "ID", providerIdList: ["2300"], packageServiceId: "DT05004", applyType: 19 },
  { countryKey: "PR", label: "波多黎各 +1787", countryCode: 1787, isoCountryCode: "PR", providerIdList: ["2300"], packageServiceId: "DT05005", applyType: 20 },
  { countryKey: "CZ", label: "捷克 +420", countryCode: 420, isoCountryCode: "CZ", providerIdList: ["2300"], packageServiceId: "DT05006", applyType: 21 },
  { countryKey: "MY", label: "马来西亚 +60", countryCode: 60, isoCountryCode: "MY", providerIdList: ["2300"], packageServiceId: "DT05007", applyType: 22 },
  { countryKey: "DK", label: "丹麦 +45", countryCode: 45, isoCountryCode: "DK", providerIdList: ["2300"], packageServiceId: "DT05008", applyType: 23 },
  { countryKey: "RO", label: "罗马尼亚 +40", countryCode: 40, isoCountryCode: "RO", providerIdList: ["2300"], packageServiceId: "DT05009", applyType: 24 }
];

export class DirectDingtoneGateway implements DingtoneGateway {
  async sendVerificationCode(_input: DingtoneLoginInput): Promise<VerificationRequestResult> {
    throw new AppError(
      "Direct gateway currently supports post-login operations only. First-login email/SMS verification still needs native activation logic.",
      501,
      501
    );
  }

  async login(_input: DingtoneLoginInput): Promise<DingtoneLoginResult> {
    throw new AppError(
      "Direct gateway currently supports post-login operations only. First-login account activation is still under reverse engineering.",
      501,
      501
    );
  }

  async exportSession(_input: DingtoneSessionExportInput): Promise<DingtoneSessionExport> {
    throw new AppError("Direct gateway does not support exporting a live app session", 501, 501);
  }

  async refreshSnapshot(account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
  }): Promise<DingtoneSnapshot> {
    const runtime = await getDirectRuntimeConfig();
    return this.withSession(runtime, account, async (session) => {
      const nextTrackCode = createDirectTrackCodeGenerator(account.dtUserId);
      const shared = {
        deviceId: accountDeviceId(account),
        trackCode: nextTrackCode(),
        userId: account.dtUserId,
        token: account.token,
        appVersion: runtime.appVersion,
        apkCertificateSign: resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign)
      };
      const balance = await session.callJson("getBalance", shared);
      const userSetting = await session.callJson("getUserSetting", {
        ...shared,
        trackCode: nextTrackCode(),
        clientUserId: account.dtUserId
      });
      cacheAccountPhoneCountryKeys(account.dtUserId, [balance, userSetting]);
      const profile = {};

      return buildSnapshot({
        account,
        balance,
        userSetting,
        profile
      });
    });
  }

  async listPhoneNumbers(account: { dtUserId: string; token: string; deviceId?: string | null }): Promise<DingtonePhoneNumber[]> {
    const runtime = await getDirectRuntimeConfig();
    return this.withSession(runtime, account, async (session) => {
      const nextTrackCode = createDirectTrackCodeGenerator(account.dtUserId);
      const payload = await session.callJson("getPrivateNumber", {
        deviceId: accountDeviceId(account),
        trackCode: nextTrackCode(),
        userId: account.dtUserId,
        token: account.token,
        clientVersion: runtime.appVersion,
        appVersion: runtime.appVersion,
        apkCertificateSign: resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign)
      });
      return normalizePhoneNumbers(payload);
    });
  }

  async listPhoneNumberCountries(account: { dtUserId: string; token: string; deviceId?: string | null }): Promise<DingtonePhoneCountryOption[]> {
    const runtime = await getDirectRuntimeConfig();
    try {
      return await this.withSession(runtime, account, async (session) => {
        const countryKeys =
          session.getAccountPhoneCountryKeys() ??
          directAccountPhoneCountryKeyCache.get(account.dtUserId) ??
          (await seedAccountPhoneCountryKeys(session, account, runtime).catch(() => undefined));
        try {
          const payload = await session.callCommonRestJson(
            "getNumberCountries",
            "/pstn/getNumberCountries",
            queryPair("apiVersion", 2)
          );
          const remoteCountries = normalizePhoneCountryOptions(payload);
          return remoteCountries.length > 0 ? orderPhoneCountryOptions(remoteCountries) : staticPhoneCountryOptions();
        } catch (error) {
          logger.warn("Direct getNumberCountries failed after session bootstrap; using APK app country list fallback", {
            countryKeys: countryKeys ? Array.from(countryKeys) : [],
            error: error instanceof Error ? error.message : String(error)
          });
          const fallback = staticPhoneCountryOptions();
          if (fallback.length > 0) {
            return fallback;
          }
          throw error;
        }
      });
    } catch (error) {
      logger.warn("Direct getNumberCountries failed; falling back to APK static country list", {
        error: error instanceof Error ? error.message : String(error)
      });
      return staticPhoneCountryOptions();
    }
  }

  async requestPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    payload: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; areaCode?: number | null }
  ): Promise<DingtonePhonePurchasePreview> {
    const runtime = await getDirectRuntimeConfig();
    const nextTrackCode = createDirectTrackCodeGenerator(account.dtUserId);
    const requestConfig = resolvePrivatePhoneRequestConfig(payload.countryCode, payload.isoCountryCode, payload.countryKey);
    const attempts = buildRequestPrivateNumberQueryAttempts(account, runtime, requestConfig, nextTrackCode(), payload.areaCode);
    const previews: DingtonePhonePurchasePreview[] = [];
    let directError: unknown;

    for (const [index, query] of attempts.entries()) {
      try {
        const result = await this.withSession(runtime, account, async (session) => {
          const preview = await session.callCommonRestJson(
            `requestPrivateNumber#${index + 1}`,
            "/pstn/share/requestPrivateNumber",
            query
          );
          const normalized = applyPreviewAttemptAreaCode(normalizePhonePurchasePreview(preview), query);
          if (normalized.candidates.length > 0) {
            return enrichPreviewWithLivePrices(session, account, normalized, requestConfig);
          }
          return normalized;
        });
        previews.push(result);
        if (result.candidates.length > 0) {
          return result;
        }
      } catch (error) {
        directError = error;
        logger.warn("Direct requestPrivateNumber attempt failed; trying next app-compatible parameter set", {
          countryCode: requestConfig.countryCode,
          isoCountryCode: requestConfig.isoCountryCode,
          attempt: index + 1,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (directError) {
      logger.warn("Direct requestPrivateNumber failed; trying configured frame template", {
        error: directError instanceof Error ? directError.message : String(directError)
      });
    }

    const result = await this.callConfiguredPhoneTemplate("dt_direct_template_request_phone", account, {
      countryCode: requestConfig.countryCode,
      isoCountryCode: payload.isoCountryCode ?? requestConfig.isoCountryCode,
      countryKey: payload.countryKey ?? requestConfig.countryKey
    }).catch((templateError) => {
      if (directError) {
        const directMessage = directError instanceof Error ? directError.message : String(directError);
        const templateMessage = templateError instanceof Error ? templateError.message : String(templateError);
        throw new AppError(`Direct requestPrivateNumber failed (${directMessage}); template fallback failed (${templateMessage})`, 501, 501);
      }
      throw templateError;
    });
    return normalizePhonePurchasePreview(result);
  }

  async purchasePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    payload: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; candidate: DingtonePhonePurchaseCandidate }
  ): Promise<DingtonePhoneNumber> {
    const templateParams = {
      ...flattenTemplateObject(payload.candidate, "candidate"),
      countryCode: payload.countryCode ?? payload.candidate.countryCode,
      countryKey: payload.countryKey ?? undefined,
      phoneNumber: payload.candidate.phoneNumber,
      areaCode: resolvePhoneActionAreaCode(payload.candidate, {
        countryCode: payload.countryCode,
        isoCountryCode: payload.isoCountryCode ?? payload.candidate.isoCountryCode,
        countryKey: payload.countryKey
      }),
      providerId: payload.candidate.providerId,
      packageServiceId: payload.candidate.packageServiceId,
      category: payload.candidate.category,
      phoneType: payload.candidate.phoneType,
      isoCountryCode: payload.isoCountryCode ?? payload.candidate.isoCountryCode,
      price: payload.candidate.price,
      productId: payload.candidate.productId
    };
    const result = await this.callDirectPhoneAction(
      "purchasePhone",
      account,
      () =>
        buildOrderPrivateNumberQuery(account, payload.candidate, {
          countryCode: payload.countryCode,
          isoCountryCode: payload.isoCountryCode ?? payload.candidate.isoCountryCode,
          countryKey: payload.countryKey,
          payFlag: 2
        }),
      "dt_direct_template_purchase_phone",
      templateParams,
      {
        acceptSocketCloseAfterWrite: true,
        queryAttempts: () =>
          buildOrderPrivateNumberQueryAttempts(account, payload.candidate, {
            countryCode: payload.countryCode,
            isoCountryCode: payload.isoCountryCode ?? payload.candidate.isoCountryCode,
            countryKey: payload.countryKey,
            payFlag: 2
          })
      }
    );
    assertDirectApiSuccess(result, "purchasePhone");
    const orderedPhone = extractOrderedPhone(result) ?? payload.candidate;
    const normalized = normalizePhoneNumber(orderedPhone);
    return {
      ...normalized,
      phoneNumber: normalized.phoneNumber || payload.candidate.phoneNumber,
      rawJson: safeJsonStringify(result)
    };
  }

  async renewPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: DirectPhoneActionContext
  ): Promise<Partial<DingtonePhoneNumber>> {
    const context = { ...phone, phoneNumber };
    const result = await this.callDirectPhoneAction(
      "renewPhone",
      account,
      () => buildOrderPrivateNumberQuery(account, context, { payFlag: context.status === "expired" ? 2 : 3 }),
      "dt_direct_template_renew_phone",
      buildPhoneTemplateParams(context, { phoneNumber })
    );
    assertDirectApiSuccess(result, "renewPhone");
    return normalizePhoneNumberPatch({
      phoneNumber,
      ...(isRecord(result) ? result : { result })
    });
  }

  async cancelPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: DirectPhoneActionContext
  ): Promise<void> {
    const context = { ...phone, phoneNumber };
    await this.callDirectPhoneAction(
      "cancelPhone",
      account,
      () => buildDeletePrivateNumberQuery(account, phoneNumber),
      "dt_direct_template_cancel_phone",
      buildPhoneTemplateParams(context, { phoneNumber, action: "cancel" })
    ).then((result) => assertDirectApiSuccess(result, "cancelPhone"));
  }

  async pausePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: DirectPhoneActionContext
  ): Promise<void> {
    const context = { ...phone, phoneNumber };
    await this.callDirectPhoneAction(
      "pausePhone",
      account,
      () => buildPrivateNumberSettingQuery(account, context, 1),
      "dt_direct_template_pause_phone",
      buildPhoneTemplateParams(context, { phoneNumber, action: "pause", suspendFlag: 1 }),
      { acceptSocketCloseAfterWrite: true }
    ).then((result) => assertDirectApiSuccess(result, "pausePhone"));
  }

  async resumePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: DirectPhoneActionContext
  ): Promise<void> {
    const context = { ...phone, phoneNumber };
    let settingWasUnconfirmed = false;
    const settingError = await this.callDirectPhoneAction(
      "resumePhone",
      account,
      () => buildPrivateNumberSettingQuery(account, context, 0),
      "dt_direct_template_resume_phone",
      buildPhoneTemplateParams(context, { phoneNumber, action: "resume", suspendFlag: 0 }),
      { acceptSocketCloseAfterWrite: true }
    )
      .then((result) => {
        assertDirectApiSuccess(result, "resumePhone");
        settingWasUnconfirmed = isUnconfirmedPhoneActionResult(result);
        return null;
      })
      .catch((error) => error);

    if (!settingError && !settingWasUnconfirmed) {
      return;
    }

    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    const reactivateApiName = settings.dt_direct_api_reactivate_phone?.trim() || "/pstn/share/reactivateGoogleVoiceNumber";

    logger.warn("Direct privateNumberSetting resume failed; trying reactivateGoogleVoiceNumber", {
      phoneNumber: redactSensitiveText(phoneNumber),
      error: settingError
        ? settingError instanceof Error
          ? settingError.message
          : String(settingError)
        : "privateNumberSetting write was not confirmed by a JSON response"
    });

    await this.callDirectPhoneAction(
      "resumePhone",
      account,
      () => buildReactivateGoogleVoiceNumberQuery(account, phoneNumber),
      "dt_direct_template_resume_phone",
      buildPhoneTemplateParams(context, { phoneNumber, action: "reactivate", suspendFlag: 0 }),
      { acceptSocketCloseAfterWrite: true, apiNameOverride: reactivateApiName }
    ).then((result) => assertDirectApiSuccess(result, "reactivatePhone"));
  }

  async updatePhoneNumberLabel(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    displayName: string,
    phone?: DirectPhoneActionContext
  ): Promise<Partial<DingtonePhoneNumber>> {
    const context = { ...phone, phoneNumber, displayName };
    const suspendFlag = context.status === "paused" ? 1 : 0;
    const result = await this.callDirectPhoneAction(
      "updatePhoneLabel",
      account,
      () => buildPrivateNumberSettingQuery(account, context, suspendFlag),
      "dt_direct_template_phone_setting",
      buildPhoneTemplateParams(context, { phoneNumber, action: "label", displayName, suspendFlag }),
      { acceptSocketCloseAfterWrite: true }
    );
    assertDirectApiSuccess(result, "updatePhoneLabel");
    return {
      phoneNumber,
      displayName,
      status: context.status
    };
  }

  async buildPhoneActionDryRuns(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    options: {
      phoneNumber?: string;
      phone?: DirectPhoneActionContext;
      candidate?: DingtonePhonePurchaseCandidate;
      countryCode?: number;
      isoCountryCode?: string | null;
      countryKey?: string | null;
    }
  ): Promise<DirectPhoneActionDryRun[]> {
    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    const actions: DirectPhoneActionDryRun[] = [];

    if (options.candidate) {
      actions.push(
        buildPhoneActionDryRun(
          "purchasePhone",
          settings,
          buildOrderPrivateNumberQuery(account, options.candidate, {
            countryCode: options.countryCode,
            isoCountryCode: options.isoCountryCode ?? options.candidate.isoCountryCode,
            countryKey: options.countryKey,
            payFlag: 2
          })
        )
      );
    }

    if (options.phoneNumber) {
      const context = { ...options.phone, phoneNumber: options.phoneNumber };
      actions.push(
        buildPhoneActionDryRun(
          "renewPhone",
          settings,
          buildOrderPrivateNumberQuery(account, context, { payFlag: context.status === "expired" ? 2 : 3 })
        ),
        buildPhoneActionDryRun("cancelPhone", settings, buildDeletePrivateNumberQuery(account, options.phoneNumber)),
        buildPhoneActionDryRun(
          "pausePhone",
          settings,
          buildPrivateNumberSettingQuery(account, context, 1)
        ),
        buildPhoneActionDryRun(
          "resumePhone",
          settings,
          buildPrivateNumberSettingQuery(account, context, 0)
        ),
        buildPhoneActionDryRun(
          "updatePhoneLabel",
          settings,
          buildPrivateNumberSettingQuery(account, { ...context, displayName: "codex-label-dry-run" }, context.status === "paused" ? 1 : 0)
        ),
        buildPhoneActionDryRun(
          "clearPhoneLabel",
          settings,
          buildPrivateNumberSettingQuery(account, { ...context, displayName: "" }, context.status === "paused" ? 1 : 0)
        )
      );
    }

    return actions;
  }

  private async callDirectPhoneAction(
    label: DirectPhoneActionLabel,
    account: { dtUserId: string; token: string; deviceId?: string | null },
    buildQuery: () => string,
    fallbackTemplateKey: DirectPhoneTemplateSettingKey,
    fallbackParams: DirectTemplateParams,
    options: { acceptSocketCloseAfterWrite?: boolean; apiNameOverride?: string; queryAttempts?: () => string[] } = {}
  ): Promise<ApiResult> {
    const runtime = await getDirectRuntimeConfig();
    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    const apiName = options.apiNameOverride
      ? normalizeDirectPhoneApiName(label, options.apiNameOverride)
      : resolvePhoneActionApiName(label, settings);
    let directError: unknown;
    try {
      return await this.withSession(runtime, account, async (session) => {
        const queries = uniqueStrings(options.queryAttempts?.() ?? [buildQuery()]);
        let lastError: unknown;
        for (const [index, query] of queries.entries()) {
          try {
            return await session.callCommonRestJson(index === 0 ? label : `${label}#${index + 1}`, apiName, query);
          } catch (error) {
            lastError = error;
            if (options.acceptSocketCloseAfterWrite && isNoResponseAfterPhoneActionWrite(error)) {
              logger.warn("Direct private phone action wrote request but did not receive JSON; verifying result without retrying purchase write", {
                label,
                apiName,
                attempt: index + 1,
                error: error instanceof Error ? error.message : String(error)
              });
              return { result: "no_response_after_write" };
            }
            logger.warn("Direct private phone action query attempt failed; trying next shape", {
              label,
              apiName,
              attempt: index + 1,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "unknown direct action error"));
      });
    } catch (error) {
      if (options.acceptSocketCloseAfterWrite && isNoResponseAfterPhoneActionWrite(error)) {
        logger.warn("Direct private phone action did not return a JSON response after request write; deferring to remote verification", {
          label,
          apiName,
          error: error instanceof Error ? error.message : String(error)
        });
        return { result: "no_response_after_write" };
      }
      directError = error;
      logger.warn("Direct private phone action failed; trying configured frame template", {
        label,
        apiName,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return this.callConfiguredPhoneTemplate(fallbackTemplateKey, account, fallbackParams).catch((templateError) => {
      const directMessage = directError instanceof Error ? directError.message : String(directError);
      const templateMessage = templateError instanceof Error ? templateError.message : String(templateError);
      throw new AppError(`Direct ${label} failed (${directMessage}); template fallback failed (${templateMessage})`, 501, 501);
    });
  }

  private async callConfiguredPhoneTemplate(
    settingKey: DirectPhoneTemplateSettingKey,
    account: { dtUserId: string; token: string; deviceId?: string | null },
    extraParams: DirectTemplateParams
  ): Promise<ApiResult> {
    const runtime = await getDirectRuntimeConfig();
    const template = await getConfiguredDirectTemplate(settingKey);
    if (!template && (settingKey === "dt_direct_template_pause_phone" || settingKey === "dt_direct_template_resume_phone")) {
      return this.callConfiguredPhoneTemplate("dt_direct_template_phone_setting", account, extraParams);
    }
    if (!template) {
      throw new AppError(
        `Direct gateway ${settingKey} is not configured yet. Capture the app frame once, save its template here, then this action can run without the app.`,
        501,
        501
      );
    }

    return this.withSession(runtime, account, async (session) => {
      const shared = buildSharedTemplateParams(account, runtime);
      const params = expandTemplateParams(
        {
          ...template.params,
          ...extraParams
        },
        account,
        runtime,
        extraParams
      );
      return session.callJsonFromTemplate(template.name, Buffer.from(template.hex.replace(/\s+/g, ""), "hex"), {
        ...shared,
        ...params
      });
    });
  }

  private async withSession<T>(
    runtime: DirectRuntimeConfig,
    account: { dtUserId: string; token: string; deviceId?: string | null; email?: string | null },
    handler: (session: DirectSession) => Promise<T>
  ): Promise<T> {
    if (preemptActiveDirectPushListener(account)) {
      await delay(750);
    }
    return runWithDirectSessionOperationLock(account, async () => {
    const hosts = uniqueHosts([runtime.primaryHost, runtime.backupHost]);
    let lastError: unknown;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      for (const host of hosts) {
        const session = new DirectSession(runtime, host);
        try {
          await session.open(account);
          const result = await handler(session);
          await session.close();
          return result;
        } catch (error) {
          lastError = error;
          await session.close().catch(() => undefined);
          logger.warn("Direct Dingtone session failed, trying next endpoint", {
            host,
            attempt,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (attempt < 2) {
        await delay(1_250);
      }
    }

    throw normalizeDirectError(lastError);
    });
  }
}

export async function runDirectSessionProbe(input: {
  account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  listenSeconds?: number;
  maxPushFrames?: number;
  customTemplates?: DirectProbeCustomTemplate[];
  phonePreviewCountryCode?: number;
}): Promise<DirectProbeResult> {
  const runtime = await getDirectRuntimeConfig();
  const hosts = uniqueHosts([runtime.primaryHost, runtime.backupHost]);
  let lastError: unknown;

  for (const host of hosts) {
    const session = new DirectSession(runtime, host);
    try {
      await session.open(input.account);
      const calls = await runProbeCalls(session, runtime, input.account, input.customTemplates ?? [], input.phonePreviewCountryCode);
      const pushes =
        input.listenSeconds && input.listenSeconds > 0
          ? await session.waitForPushes(input.listenSeconds * 1000, input.maxPushFrames ?? 5)
          : [];
      await session.close();
      return {
        ok: calls.some((call) => call.ok) || pushes.length > 0,
        host,
        dtUserId: input.account.dtUserId,
        deviceId: input.account.deviceId,
        calls,
        pushes,
        trace: session.getTrace()
      };
    } catch (error) {
      lastError = error;
      await session.close().catch(() => undefined);
      logger.warn("Direct Dingtone probe failed, trying next endpoint", {
        host,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  throw normalizeDirectError(lastError);
}

export async function listenDirectSessionPushes(input: {
  account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  listenSeconds: number;
  maxPushFrames?: number;
  onPush?: (push: DirectProbePushResult) => Promise<void> | void;
  onFrame?: (push: DirectProbePushResult, host: string) => Promise<void> | void;
}) {
  const runtime = await getDirectRuntimeConfig();
  const baseHosts = uniqueHosts([runtime.primaryHost, runtime.backupHost, ...APP_DIRECT_PUSH_HOSTS]);
  const maxPushFrames = input.maxPushFrames ?? Number.MAX_SAFE_INTEGER;
  const deadline = Date.now() + Math.max(1, input.listenSeconds) * 1000;
  const pushes: DirectProbePushResult[] = [];
  const trace: DirectProbeFrameTrace[] = [];
  let offlineTemplateSent = false;
  let offlineTemplateError: string | null = null;
  let offlineTemplateAttempted = false;
  const calls: DirectProbeCallResult[] = [];
  const listener: ActiveDirectPushListener = {
    key: directSessionAccountKey(input.account),
    preempted: false,
    sessions: new Set()
  };
  let lastError: unknown;
  let selectedHost = baseHosts[0] ?? runtime.primaryHost;
  let attempts = 0;

  preemptActiveDirectPushListener(input.account);
  activeDirectPushListeners.set(listener.key, listener);

  try {
    const discoveredHosts = await discoverDirectPushHosts(runtime, input.account, baseHosts, listener, calls, deadline);
    const hosts = uniqueHosts([...baseHosts, ...discoveredHosts]);
    if (discoveredHosts.length > 0) {
      logger.info("Direct push listener added RTC hosts discovered from queryRtcServersEx", {
        dtUserId: input.account.dtUserId,
        hosts: discoveredHosts
      });
    }
    const hostErrors: unknown[] = [];
    let hostCursor = 0;
    const nextListenHost = () => hosts[hostCursor++ % hosts.length] ?? runtime.primaryHost;
    const workerCount = Math.max(1, Math.min(runtime.listenHostConcurrency, hosts.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (!listener.preempted && Date.now() < deadline && pushes.length < maxPushFrames) {
          const host = nextListenHost();
          await waitForDirectSessionOperationIdle(input.account);
          if (listener.preempted || Date.now() >= deadline || pushes.length >= maxPushFrames) {
            break;
          }

          const session = new DirectSession(runtime, host);
          listener.session = session;
          listener.sessions?.add(session);
          attempts += 1;
          selectedHost = host;
          try {
            await session.open(input.account);
            calls.push(...(await runPushListenPrimeCalls(session, runtime, input.account)));
            if (!offlineTemplateAttempted) {
              offlineTemplateAttempted = true;
              try {
                const sent = await session.sendConfiguredTemplate("dt_direct_template_offline_messages", input.account, {
                  action: "requestAllOfflineMessage"
                });
                offlineTemplateSent = offlineTemplateSent || sent;
                if (!sent) {
                  offlineTemplateError = offlineTemplateError ?? "dt_direct_template_offline_messages is not configured";
                }
              } catch (error) {
                offlineTemplateError = error instanceof Error ? error.message : String(error);
                logger.warn("Direct offline message template was not sent", {
                  host,
                  error: offlineTemplateError
                });
              }
            }
            const remainingMs = Math.max(250, deadline - Date.now());
            const remainingFrames = Math.max(0, maxPushFrames - pushes.length);
            if (remainingFrames <= 0) {
              break;
            }
            const nextPushes = await session.waitForPushes(remainingMs, remainingFrames, input.onPush, input.onFrame);
            pushes.push(...nextPushes);
            trace.push(...session.getTrace());
            lastError = undefined;
            await session.close();
          } catch (error) {
            lastError = error;
            hostErrors.push(error);
            trace.push(...session.getTrace());
            await session.close().catch(() => undefined);
            if (!listener.preempted) {
              logger.warn("Direct Dingtone push listen failed, reconnecting inside listen window", {
                host,
                attempt: attempts,
                error: error instanceof Error ? error.message : String(error)
              });

              if (isFatalDirectSessionError(error)) {
                throw normalizeDirectError(error);
              }
              const backoffMs = Math.min(10_000, 1_000 + Math.min(attempts, 6) * 1_000);
              if (Date.now() + backoffMs < deadline) {
                await delay(backoffMs);
              }
            }
          } finally {
            listener.sessions?.delete(session);
            if (listener.session === session) {
              listener.session = undefined;
            }
          }
        }
      })
    ).catch((error) => {
      lastError = error;
      hostErrors.push(error);
    });

    const fatalError = hostErrors.find((error) => isFatalDirectSessionError(error));
    if (fatalError) {
      throw normalizeDirectError(fatalError);
    }
  } finally {
    if (activeDirectPushListeners.get(listener.key) === listener) {
      activeDirectPushListeners.delete(listener.key);
    }
    if (listener.preempted && !offlineTemplateAttempted && !offlineTemplateError) {
      offlineTemplateError = "direct listener was preempted before offline template could be sent";
    }
  }

  if (attempts === 0 && lastError) {
    throw normalizeDirectError(lastError);
  }

  return {
    ok: pushes.length > 0,
    host: selectedHost,
    dtUserId: input.account.dtUserId,
    deviceId: input.account.deviceId,
    calls,
    pushes,
    trace,
    offlineTemplateAttempted,
    offlineTemplateSent,
    offlineTemplateError,
    preempted: listener.preempted
  };
}

async function discoverDirectPushHosts(
  runtime: DirectRuntimeConfig,
  account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
  },
  hosts: string[],
  listener: ActiveDirectPushListener,
  calls: DirectProbeCallResult[],
  deadline: number
) {
  const shared = {
    deviceId: accountDeviceId(account),
    userId: account.dtUserId,
    token: account.token,
    clientVersion: runtime.appVersion,
    appVersion: runtime.appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign)
  };
  const nextTrackCode = createDirectTrackCodeGenerator(account.dtUserId);
  const discovered: string[] = [];
  const visited = new Set<string>();
  const pending = uniqueHosts(hosts);
  const maxDiscoveryHosts = Math.max(1, Math.min(runtime.listenHostConcurrency, 4));
  const batchSize = maxDiscoveryHosts;

  while (!listener.preempted && Date.now() < deadline && pending.length > 0 && visited.size < maxDiscoveryHosts) {
    const batch = pending.splice(0, batchSize).filter((host) => {
      if (visited.has(host)) {
        return false;
      }
      visited.add(host);
      return true;
    });
    if (batch.length === 0) {
      continue;
    }

    await Promise.all(
      batch.map(async (host) => {
      if (listener.preempted || Date.now() >= deadline) {
        return;
      }
      await waitForDirectSessionOperationIdle(account);
      if (listener.preempted || Date.now() >= deadline) {
        return;
      }

      const session = new DirectSession(runtime, host);
      listener.sessions?.add(session);
      try {
        await session.open(account);
        const call = await timeProbeCall(session, `discover.queryRtcServersEx@${host}`, () =>
          session.callJson("queryRtcServersEx", { ...shared, trackCode: nextTrackCode() })
        );
        calls.push(call);
        if (call.payload) {
          const nextHosts = extractRtcServerHosts(call.payload);
          discovered.push(...nextHosts);
          for (const nextHost of nextHosts) {
            if (!visited.has(nextHost) && !pending.includes(nextHost)) {
              pending.push(nextHost);
            }
          }
        }
      } catch (error) {
        logger.warn("Direct queryRtcServersEx discovery failed", {
          host,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        listener.sessions?.delete(session);
        await session.close().catch(() => undefined);
      }
      })
    );
  }

  return uniqueHosts(discovered).filter((host) => !hosts.includes(host));
}

async function runPushListenPrimeCalls(
  session: DirectSession,
  runtime: DirectRuntimeConfig,
  account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
  }
) {
  const shared = {
    deviceId: accountDeviceId(account),
    userId: account.dtUserId,
    token: account.token,
    clientVersion: runtime.appVersion,
    appVersion: runtime.appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign)
  };
  const nextTrackCode = createDirectTrackCodeGenerator(account.dtUserId);
  const calls: DirectProbeCallResult[] = [];

  // The Android app refreshes balance and private-number state immediately before
  // inbound SMS pushes arrive. Server-only listeners need to mimic that path.
  for (const item of [
    { name: "listenPrime.followerListInfo" as const, templateName: "followerListInfo" as const },
    { name: "listenPrime.getFriendList" as const, templateName: "getFriendList" as const },
    { name: "listenPrime.infoBus" as const, templateName: "infoBus" as const },
    {
      name: "listenPrime.glbUserPropertites" as const,
      apiName: "glb/userPropertites",
      query: buildGlbUserPropertiesQuery(account, runtime, nextTrackCode())
    },
    {
      name: "listenPrime.gwebInfoBus" as const,
      apiName: "gwebsvr/infoBus",
      query: buildGwebInfoBusQuery(account, runtime, nextTrackCode())
    },
    { name: "listenPrime.queryRtcServersEx#flags9" as const, templateName: "queryRtcServersEx" as const, params: { flags: 9 } },
    { name: "listenPrime.queryRtcServersEx#flags5" as const, templateName: "queryRtcServersEx" as const, params: { flags: 5 } },
    {
      name: "listenPrime.getNumberCountries" as const,
      apiName: "/pstn/getNumberCountries",
      query: buildGetNumberCountriesQuery(account, runtime, nextTrackCode())
    },
    { name: "listenPrime.updateClientLink" as const, templateName: "updateClientLink" as const },
    { name: "listenPrime.getUserSetting" as const, templateName: "getUserSetting" as const },
    { name: "listenPrime.getBalance" as const, templateName: "getBalance" as const },
    { name: "listenPrime.getPrivateNumber#1" as const, templateName: "getPrivateNumber" as const },
    { name: "listenPrime.getPrivateNumber#2" as const, templateName: "getPrivateNumber" as const }
  ]) {
    const startedAt = Date.now();
    try {
      if ("apiName" in item && item.apiName && item.query) {
        await session.sendCommonRestJson(item.name, item.apiName, item.query);
      } else if ("templateName" in item && item.templateName) {
        await session.sendJson(item.templateName, { ...shared, ...(item.params ?? {}), trackCode: nextTrackCode() });
      }
      calls.push({
        name: item.name,
        ok: true,
        durationMs: Date.now() - startedAt,
        payload: { sent: true }
      });
    } catch (error) {
      calls.push({
        name: item.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return calls;
}

function extractRtcServerHosts(payload: ApiResult) {
  const hosts: string[] = [];
  for (const record of collectNestedRecords(payload)) {
    const ip = pickString(record, ["ip", "host", "serverIp", "server_ip"]);
    if (ip && isLikelyIpv4Host(ip)) {
      hosts.push(ip);
    }
  }
  return uniqueHosts(hosts);
}

function isLikelyIpv4Host(value: string) {
  const parts = value.trim().split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const number = Number(part);
    return Number.isInteger(number) && number >= 0 && number <= 255;
  });
}

export function preemptDirectSessionPushListener(account: { dtUserId: string; deviceId?: string | null }) {
  return preemptActiveDirectPushListener(account);
}

export function buildDirectAccessCodeDryRun(input: {
  kind: "email" | "phone";
  target: string;
  countryCode?: number;
  accessCode?: string | number | null;
  noCode?: number;
}): DirectAccessCodeDryRun {
  assertValidAccessCodeTarget(input.kind, input.target);
  const countryCode = resolveAccessCodeCountryCode(input.kind, input.target, input.countryCode);
  const recoverPasswordQuery = buildRecoverPasswordQuery(input.kind, input.target, countryCode, input.noCode);
  const accessCode = input.accessCode;
  const verifyAccessCodeQuery =
    accessCode === undefined || accessCode === null || String(accessCode).trim() === ""
      ? undefined
      : buildVerifyAccessCodeQuery(input.kind, input.target, countryCode, accessCode);
  return {
    capability: ACCESS_CODE_PROBE_CAPABILITY,
    kind: input.kind,
    target: redactAccessCodeTarget(input.kind, input.target),
    countryCode,
    recoverPassword: {
      apiName: "recoverPassword",
      query: recoverPasswordQuery,
      params: parseQueryParams(recoverPasswordQuery)
    },
    verifyAccessCode: verifyAccessCodeQuery
      ? {
          apiName: "verifyAccessCode",
          query: verifyAccessCodeQuery,
          params: parseQueryParams(verifyAccessCodeQuery)
        }
      : undefined
  };
}

export async function runDirectAccessCodeProbe(input: {
  account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  kind: "email" | "phone";
  target: string;
  countryCode?: number;
  accessCode?: string | number | null;
  noCode?: number;
}): Promise<DirectAccessCodeProbeResult> {
  assertValidAccessCodeTarget(input.kind, input.target);
  const runtime = await getDirectRuntimeConfig();
  const hosts = uniqueHosts([runtime.primaryHost, runtime.backupHost]);
  let lastError: unknown;

  for (const host of hosts) {
    const session = new DirectSession(runtime, host);
    try {
      await session.open(input.account);
      const recoverPassword = await timeProbeCall(session, "recoverPassword", () =>
        session.callCommonRestJson(
          "recoverPassword",
          "recoverPassword",
          buildRecoverPasswordQuery(
            input.kind,
            input.target,
            resolveAccessCodeCountryCode(input.kind, input.target, input.countryCode),
            input.noCode
          )
        )
      );
      const accessCode = input.accessCode;
      const verifyAccessCode =
        accessCode === undefined || accessCode === null || String(accessCode).trim() === ""
          ? undefined
          : await timeProbeCall(session, "verifyAccessCode", () =>
              session.callCommonRestJson(
                "verifyAccessCode",
                "verifyAccessCode",
                buildVerifyAccessCodeQuery(
                  input.kind,
                  input.target,
                  resolveAccessCodeCountryCode(input.kind, input.target, input.countryCode),
                  accessCode
                )
              )
            );
      await session.close();
      return {
        ok: Boolean(recoverPassword.ok || verifyAccessCode?.ok),
        host,
        dtUserId: input.account.dtUserId,
        deviceId: input.account.deviceId,
        capability: ACCESS_CODE_PROBE_CAPABILITY,
        recoverPassword,
        verifyAccessCode,
        trace: session.getTrace()
      };
    } catch (error) {
      lastError = error;
      await session.close().catch(() => undefined);
      logger.warn("Direct access-code probe failed, trying next endpoint", {
        host,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  throw normalizeDirectError(lastError);
}

async function runProbeCalls(
  session: DirectSession,
  runtime: DirectRuntimeConfig,
  account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
  },
  customTemplates: DirectProbeCustomTemplate[],
  phonePreviewCountryCode?: number
) {
  const shared = {
    deviceId: accountDeviceId(account),
    userId: account.dtUserId,
    token: account.token,
    clientVersion: runtime.appVersion,
    appVersion: runtime.appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign)
  };
  const calls: DirectProbeCallResult[] = [];
  const nextTrackCode = createDirectTrackCodeGenerator(account.dtUserId);

  for (const item of [
    { name: "getBalance" as const, params: { ...shared, trackCode: nextTrackCode() } },
    { name: "getUserSetting" as const, params: { ...shared, trackCode: nextTrackCode(), clientUserId: account.dtUserId } },
    { name: "getPrivateNumber" as const, params: { ...shared, trackCode: nextTrackCode() } }
  ]) {
    calls.push(await timeProbeCall(session, item.name, () => session.callJson(item.name, item.params)));
  }

  if (phonePreviewCountryCode) {
    calls.push(
      await timeProbeCall(session, `requestPrivateNumber(+${phonePreviewCountryCode})`, () =>
        session.callCommonRestJson(
          "requestPrivateNumber",
          "/pstn/share/requestPrivateNumber",
          buildRequestPrivateNumberQuery(
            account,
            runtime,
            resolvePrivatePhoneRequestConfig(phonePreviewCountryCode),
            nextTrackCode()
          )
        )
      )
    );
  }

  for (const template of customTemplates) {
    const params = expandTemplateParams(template.params ?? {}, account, runtime);
    calls.push(
      await timeProbeCall(session, template.name, () =>
        session.callJsonFromTemplate(template.name, Buffer.from(template.hex.replace(/\s+/g, ""), "hex"), {
          ...shared,
          ...params
        })
      )
    );
  }

  return calls;
}

async function timeProbeCall(
  session: DirectSession,
  name: string,
  task: () => Promise<ApiResult>
): Promise<DirectProbeCallResult> {
  const startedAt = Date.now();
  const traceStart = session.getTrace().length;
  try {
    const payload = await task();
    return {
      name,
      ok: true,
      durationMs: Date.now() - startedAt,
      payload,
      frames: session.getTrace().slice(traceStart)
    };
  } catch (error) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      frames: session.getTrace().slice(traceStart)
    };
  }
}

function expandTemplateParams(
  params: DirectTemplateParams,
  account: { dtUserId: string; token: string; deviceId?: string | null },
  runtime: DirectRuntimeConfig,
  extraVars: DirectTemplateParams = {}
) {
  const expanded: DirectTemplateParams = {};
  const vars: Record<string, string | number | boolean | undefined> = {
    dtUserId: account.dtUserId,
    userId: account.dtUserId,
    token: account.token,
    deviceId: accountDeviceId(account),
    trackCode: createDirectTrackCode(account.dtUserId),
    appVersion: runtime.appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign),
    ...extraVars
  };

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.startsWith("$")) {
      expanded[key] = vars[value.slice(1)] ?? value;
      continue;
    }
    expanded[key] = value;
  }

  return expanded;
}

function buildSharedTemplateParams(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  runtime: DirectRuntimeConfig
): DirectTemplateParams {
  return {
    deviceId: accountDeviceId(account),
    userId: account.dtUserId,
    token: account.token,
    trackCode: createDirectTrackCode(account.dtUserId),
    clientVersion: runtime.appVersion,
    appVersion: runtime.appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign)
  };
}

function extractBootstrapPhoneCountryKeys(payloads: ApiResult[]) {
  const values: string[] = [];
  for (const record of collectRecords(payloads)) {
    const raw =
      pickString(record, ["userNumberCountry", "user_number_country", "numberCountry", "number_country"]) ??
      pickString(record, ["userNumberCountries", "user_number_countries"]);
    if (raw) {
      values.push(...raw.split(","));
    }
  }

  const normalized = values
    .map((item) => normalizeAccountCountryKey(item))
    .filter((item): item is string => Boolean(item));
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

async function seedAccountPhoneCountryKeys(
  session: DirectSession,
  account: { dtUserId: string; token: string; deviceId?: string | null },
  runtime: DirectRuntimeConfig
) {
  const nextTrackCode = createDirectTrackCodeGenerator(account.dtUserId);
  const shared = {
    deviceId: accountDeviceId(account),
    trackCode: nextTrackCode(),
    userId: account.dtUserId,
    token: account.token,
    clientVersion: runtime.appVersion,
    appVersion: runtime.appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign)
  };
  const balance = await session.callJson("getBalance", shared).catch(() => null);
  const userSetting = await session.callJson("getUserSetting", {
    ...shared,
    trackCode: nextTrackCode(),
    clientUserId: account.dtUserId
  }).catch(() => null);
  return cacheAccountPhoneCountryKeys(account.dtUserId, [balance, userSetting]);
}

function cacheAccountPhoneCountryKeys(accountKey: string, payloads: Array<ApiResult | null>) {
  const keys = extractBootstrapPhoneCountryKeys(payloads.filter((item): item is ApiResult => Boolean(item)));
  if (keys) {
    directAccountPhoneCountryKeyCache.set(accountKey, keys);
  }
  return keys;
}

function normalizeAccountCountryKey(value: string) {
  const item = value.trim().toUpperCase();
  if (!item) {
    return undefined;
  }
  if (item === "UK") {
    return "GB";
  }
  if (item === "1-CA") {
    return "CA";
  }
  return item;
}

class DirectSession {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private resolvers: Array<(value: Buffer) => void> = [];
  private rejectors: Array<(error: Error) => void> = [];
  private jsonQueue: ApiResult[] = [];
  private jsonResolvers: Array<(value: ApiResult) => void> = [];
  private jsonRejectors: Array<(error: Error) => void> = [];
  private pendingPushes: DirectProbePushResult[] = [];
  private accountPhoneCountryKeys?: Set<string>;
  private account?: DirectSessionAccount;
  private closed = false;
  private sessionId = Buffer.alloc(4);
  private route = Buffer.alloc(8);
  private trace: DirectProbeFrameTrace[] = [];
  private pushDeliveryConfirmSerial = 6;

  constructor(private runtime: DirectRuntimeConfig, private host: string) {}

  async open(account: DirectSessionAccount) {
    this.account = account;
    this.socket = await this.connectSocket(this.host, this.runtime.port, this.runtime.connectTimeoutMs);
    this.attachSocketEvents();
    await this.write(CONNECT_REQUEST);

    const connectResp = await this.waitForFrame((frame) => frame.type === 0x8102, this.runtime.ioTimeoutMs, "connect response");
    this.sessionId = Buffer.from(connectResp.raw.subarray(14, 18));

    const prelogin = buildRequestFrame({
      template: TEMPLATES.getInfoBeforeLogin,
      session: this.sessionId,
      route: undefined,
      status: 0x0101,
      params: {
        deviceID: accountDeviceId(account),
        notPreLogin: "true",
        userID: account.dtUserId
      }
    });
    await this.write(prelogin);

    const preloginResp = await this.waitForFrame(
      (frame) => frame.type === 0x8107 && frame.status === 0x0101,
      this.runtime.ioTimeoutMs,
      "getInfoBeforeLogin response"
    );
    this.route = Buffer.from(preloginResp.body.subarray(8, 16));
    await this.bootstrapAuthenticatedSession(account);
  }

  async callJson(templateName: keyof typeof TEMPLATES, params: DirectTemplateParams) {
    return this.callJsonFromTemplate(String(templateName), TEMPLATES[templateName], params);
  }

  async sendJson(templateName: keyof typeof TEMPLATES, params: DirectTemplateParams) {
    const request = buildRequestFrame({
      template: TEMPLATES[templateName],
      session: this.sessionId,
      route: this.route,
      status: 0x0102,
      params: {
        ...routeQueryParams(this.route),
        ...params,
        appVersion: params.appVersion ?? this.runtime.appVersion,
        apkCertificateSign: params.apkCertificateSign ?? this.runtime.apkCertificateSign
      }
    });
    await this.write(request);
  }

  async callCommonRestJson(label: string, apiName: string, query: string) {
    const request = buildCommonRestRequestFrame({
      template: TEMPLATES.getPrivateNumber,
      session: this.sessionId,
      route: this.route,
      status: 0x0102,
      apiName,
      query
    });

    this.clearJsonQueue();
    await this.write(request);
    return this.waitForJsonPayload(this.runtime.ioTimeoutMs, `${label} JSON response`);
  }

  async sendCommonRestJson(label: string, apiName: string, query: string) {
    const request = buildCommonRestRequestFrame({
      template: TEMPLATES.getPrivateNumber,
      session: this.sessionId,
      route: this.route,
      status: 0x0102,
      apiName,
      query
    });

    await this.write(request);
  }

  getAccountPhoneCountryKeys() {
    return this.accountPhoneCountryKeys;
  }

  async callJsonFromTemplate(label: string, template: Buffer, params: DirectTemplateParams) {
    const request = buildRequestFrame({
      template,
      session: this.sessionId,
      route: this.route,
      status: 0x0102,
      params: {
        ...routeQueryParams(this.route),
        ...params,
        appVersion: params.appVersion ?? this.runtime.appVersion,
        apkCertificateSign: params.apkCertificateSign ?? this.runtime.apkCertificateSign
      }
    });

    this.clearJsonQueue();
    await this.write(request);
    return this.waitForJsonPayload(this.runtime.ioTimeoutMs, `${label} JSON response`);
  }

  async sendConfiguredTemplate(
    settingKey: DirectTemplateSettingKey,
    account: { dtUserId: string; token: string; deviceId?: string | null },
    extraParams: DirectTemplateParams
  ) {
    const template = await getConfiguredDirectTemplate(settingKey) ?? getBuiltInDirectTemplate(settingKey);
    if (!template) {
      return false;
    }
    const params = expandTemplateParams(
      {
        ...(template.params ?? {}),
        ...extraParams
      },
      account,
      this.runtime
    );
    const frame = buildTemplateSendFrame({
      template: Buffer.from(template.hex.replace(/\s+/g, ""), "hex"),
      session: this.sessionId,
      route: this.route,
      status: 0x0102,
      params: {
        ...buildSharedTemplateParams(account, this.runtime),
        ...routeQueryParams(this.route),
        ...params
      }
    });
    await this.write(frame);
    return true;
  }

  async waitForPushes(
    timeoutMs: number,
    maxFrames: number,
    onPush?: (push: DirectProbePushResult) => Promise<void> | void,
    onFrame?: (push: DirectProbePushResult, host: string) => Promise<void> | void
  ) {
    const pushes: DirectProbePushResult[] = [];
    const deadline = Date.now() + timeoutMs;
    let nonSmsPushFrameCount = 0;

    while (this.pendingPushes.length > 0 && pushes.length < maxFrames) {
      const push = this.pendingPushes.shift()!;
      pushes.push(push);
      await onFrame?.(push, this.host);
      await onPush?.(push);
    }

    while (pushes.length < maxFrames && Date.now() < deadline) {
      try {
        const frame = await this.waitForFrame(
          (candidate) => candidate.type === 0x8107,
          Math.max(250, deadline - Date.now()),
          "direct push frame"
        );
        const push = frameToDirectPush(frame);
        await onFrame?.(push, this.host);
        if (!push.sms) {
          nonSmsPushFrameCount += 1;
          if (nonSmsPushFrameCount <= 5) {
            logger.info("Direct push frame skipped because it did not contain an SMS payload", {
              host: this.host,
              status: push.status,
              bodyLength: push.bodyLength,
              hasJsonPayload: Boolean(push.jsonPayload),
              jsonPayload: summarizeJsonPayload(push.jsonPayload)
            });
          }
          continue;
        }
        pushes.push(push);
        await onPush?.(push);
      } catch (error) {
        if (
          (error instanceof AppError && error.statusCode === 504) ||
          (error instanceof Error && /socket closed/i.test(error.message))
        ) {
          break;
        }
        throw error;
      }
    }

    return pushes;
  }

  async close() {
    this.closed = true;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }

  getTrace() {
    return [...this.trace];
  }

  private async connectSocket(host: string, port: number, timeoutMs: number) {
    const socket = this.runtime.useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AppError(`Direct gateway connection timed out: ${host}:${port}`, 504, 504));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    return socket;
  }

  private attachSocketEvents() {
    if (!this.socket) {
      return;
    }
    this.socket.on("data", (chunk) => this.consume(chunk));
    this.socket.on("error", (error) => {
      this.failWaiters(error instanceof Error ? error : new Error(String(error)));
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.failWaiters(new Error("Direct gateway socket closed"));
    });
  }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 6) {
      if (this.buffer[0] !== 0x01 || this.buffer[1] !== 0x07) {
        const next = this.buffer.indexOf(Buffer.from([0x01, 0x07]), 1);
        if (next < 0) {
          this.buffer = Buffer.alloc(0);
          return;
        }
        this.buffer = this.buffer.subarray(next);
        continue;
      }

      const totalLen = this.buffer.readUInt32BE(2);
      if (totalLen < 12 || this.buffer.length < totalLen) {
        return;
      }

      const frame = this.buffer.subarray(0, totalLen);
      this.buffer = this.buffer.subarray(totalLen);
      const parsed = parseFrame(frame);
      const jsonPayload = extractJsonPayload(parsed.raw);
      this.trace.push({
        receivedAt: new Date().toISOString(),
        frameType: parsed.type,
        status: parsed.status,
        routeHex: parsed.route?.toString("hex"),
        rawLength: parsed.raw.length,
        bodyLength: parsed.body.length,
        rawHexPreview: parsed.raw.subarray(0, 160).toString("hex"),
        bodyHexPreview: parsed.body.subarray(0, 160).toString("hex"),
        jsonPayload
      });
      if (this.trace.length > MAX_DIRECT_TRACE_FRAMES) {
        this.trace.splice(0, this.trace.length - MAX_DIRECT_TRACE_FRAMES);
      }
      if (jsonPayload) {
        this.jsonQueue.push(jsonPayload);
        this.flushJsonWaiters();
      }
      const smsPush = parsed.type === 0x8107 && parsed.status === 0x0103 ? tryParseSmsPush(parsed.raw) ?? tryParseSmsPush(parsed.body) : null;
      if (parsed.type === 0x8107 && parsed.status === 0x0103) {
        void this.acknowledgePushFrame(parsed, Boolean(smsPush)).catch((error) => {
          logger.warn("Direct push ACK failed", {
            host: this.host,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      this.queue.push(frame);
      this.flushWaiters();
    }
  }

  private async write(frame: Buffer) {
    if (!this.socket) {
      throw new Error("Direct gateway socket is not open");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket!.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async acknowledgePushFrame(frame: ParsedFrame, shouldConfirmDelivery: boolean) {
    const ack = buildPushAckFrame(frame);
    if (!ack) {
      return;
    }
    await this.write(ack);
    if (!shouldConfirmDelivery || !this.account) {
      return;
    }
    const confirm = buildPushDeliveryConfirmFrame(frame, this.account, this.nextPushDeliveryConfirmSerial());
    if (confirm) {
      await this.write(confirm);
    }
  }

  private nextPushDeliveryConfirmSerial() {
    const value = this.pushDeliveryConfirmSerial;
    this.pushDeliveryConfirmSerial = (this.pushDeliveryConfirmSerial + 1) & 0xffffff;
    if (this.pushDeliveryConfirmSerial === 0) {
      this.pushDeliveryConfirmSerial = 1;
    }
    return value;
  }

  private async bootstrapAuthenticatedSession(account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
  }) {
    const nextTrackCode = createDirectTrackCodeGenerator(account.dtUserId);
    const packet = buildLoginInitPacket({
      session: this.sessionId,
      route: this.route,
      runtime: this.runtime,
      account,
      loginTrackCode: nextTrackCode(),
      configTrackCode: nextTrackCode()
    });
    await this.write(packet);
    await this.drainBootstrapFrames(3_000);
    this.accountPhoneCountryKeys = extractBootstrapPhoneCountryKeys(this.jsonQueue);
    if (this.accountPhoneCountryKeys) {
      directAccountPhoneCountryKeyCache.set(account.dtUserId, this.accountPhoneCountryKeys);
    }
    const bootstrapError = this.findBootstrapError();
    if (bootstrapError) {
      throw new AppError(`Direct session bootstrap failed: ${bootstrapError}`, 401, 401);
    }
    this.clearJsonQueue();
  }

  private findBootstrapError() {
    for (const payload of this.jsonQueue) {
      if (!isRecord(payload)) {
        continue;
      }
      const result = payload.Result ?? payload.result;
      const errCode = payload.ErrCode ?? payload.errCode ?? payload.errorCode;
      if (result === 0 || errCode !== undefined) {
        const reason = stringifyPrimitive(payload.Reason ?? payload.reason ?? payload.message ?? payload.error);
        return reason
          ? `${redactSensitiveText(reason)} (${String(errCode ?? "Result=0")})`
          : `server returned ${String(errCode ?? "Result=0")}`;
      }
    }
    return undefined;
  }

  private async drainBootstrapFrames(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const frame = await this.waitForFrame(
          (candidate) => candidate.type === 0x8107,
          Math.max(250, Math.min(1_000, deadline - Date.now())),
          "login bootstrap response"
        );
        const push = frameToDirectPush(frame);
        if (push.sms) {
          this.pendingPushes.push(push);
        }
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 504) {
          break;
        }
        throw error;
      }
    }
  }

  private async waitForFrame(
    predicate: (frame: ParsedFrame) => boolean,
    timeoutMs: number,
    label: string
  ): Promise<ParsedFrame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.queue.findIndex((frame) => predicate(parseFrame(frame)));
      if (index >= 0) {
        const raw = this.queue.splice(index, 1)[0];
        if (!raw) {
          continue;
        }
        return parseFrame(raw);
      }

      const remaining = Math.max(250, deadline - Date.now());
      const raw = await this.nextRawFrame(remaining, label);
      if (predicate(parseFrame(raw))) {
        return parseFrame(raw);
      }
    }

    throw new AppError(`Timed out waiting for ${label}`, 504, 504);
  }

  private nextRawFrame(timeoutMs: number, label: string) {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }

    if (this.closed) {
      return Promise.reject(new Error(`Direct gateway socket closed while waiting for ${label}`));
    }

    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeResolver(resolve, reject);
        reject(new AppError(`Timed out waiting for ${label}`, 504, 504));
      }, timeoutMs);

      const resolver = (value: Buffer) => {
        clearTimeout(timer);
        resolve(value);
      };
      const rejector = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };

      this.resolvers.push(resolver);
      this.rejectors.push(rejector);
    });
  }

  private waitForJsonPayload(timeoutMs: number, label: string) {
    if (this.jsonQueue.length > 0) {
      return Promise.resolve(this.jsonQueue.shift()!);
    }

    if (this.closed) {
      return Promise.reject(new Error(`Direct gateway socket closed while waiting for ${label}`));
    }

    return new Promise<ApiResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeJsonResolver(resolve, reject);
        reject(new AppError(`Timed out waiting for ${label}`, 504, 504));
      }, timeoutMs);

      const resolver = (value: ApiResult) => {
        clearTimeout(timer);
        resolve(value);
      };
      const rejector = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };

      this.jsonResolvers.push(resolver);
      this.jsonRejectors.push(rejector);
    });
  }

  private flushWaiters() {
    while (this.queue.length > 0 && this.resolvers.length > 0) {
      const frame = this.queue.shift()!;
      const resolver = this.resolvers.shift()!;
      this.rejectors.shift();
      resolver(frame);
    }
  }

  private flushJsonWaiters() {
    while (this.jsonQueue.length > 0 && this.jsonResolvers.length > 0) {
      const payload = this.jsonQueue.shift()!;
      const resolver = this.jsonResolvers.shift()!;
      this.jsonRejectors.shift();
      resolver(payload);
    }
  }

  private failWaiters(error: Error) {
    while (this.rejectors.length > 0) {
      const rejector = this.rejectors.shift()!;
      this.resolvers.shift();
      rejector(error);
    }
    while (this.jsonRejectors.length > 0) {
      const rejector = this.jsonRejectors.shift()!;
      this.jsonResolvers.shift();
      rejector(error);
    }
  }

  private removeResolver(resolver: (value: Buffer) => void, rejector: (error: Error) => void) {
    const index = this.resolvers.indexOf(resolver);
    if (index >= 0) {
      this.resolvers.splice(index, 1);
      this.rejectors.splice(index, 1);
      return;
    }
    const rejectIndex = this.rejectors.indexOf(rejector);
    if (rejectIndex >= 0) {
      this.resolvers.splice(rejectIndex, 1);
      this.rejectors.splice(rejectIndex, 1);
    }
  }

  private removeJsonResolver(resolver: (value: ApiResult) => void, rejector: (error: Error) => void) {
    const index = this.jsonResolvers.indexOf(resolver);
    if (index >= 0) {
      this.jsonResolvers.splice(index, 1);
      this.jsonRejectors.splice(index, 1);
      return;
    }
    const rejectIndex = this.jsonRejectors.indexOf(rejector);
    if (rejectIndex >= 0) {
      this.jsonResolvers.splice(rejectIndex, 1);
      this.jsonRejectors.splice(rejectIndex, 1);
    }
  }

  private clearJsonQueue() {
    this.jsonQueue = [];
  }
}

function getDirectTemplateBody(template: Buffer) {
  const totalLen = template.readUInt32BE(2);
  const frame = template.subarray(0, totalLen);
  const body = frame.subarray(22);
  return { frame, body };
}

function buildRequestFrame(input: {
  template: Buffer;
  session: Buffer;
  route?: Buffer;
  status: number;
  params: DirectTemplateParams;
}) {
  const { body: templateBody } = getDirectTemplateBody(input.template);
  if (input.template === TEMPLATES.getInfoBeforeLogin) {
    return encodeFrame(input.session, input.status, buildPreLoginBody(templateBody, input.params));
  }

  const zlibOffset = findZlibOffset(templateBody);
  if (zlibOffset < 0) {
    throw new Error("Template body does not contain a zlib payload");
  }
  if (zlibOffset < 8) {
    throw new Error("Template zlib payload is missing length fields");
  }

  const prefix = Buffer.from(templateBody.subarray(0, zlibOffset - 8));
  const templateCompressedLength = templateBody.readUInt32BE(zlibOffset - 4);
  const suffix = templateBody.subarray(zlibOffset + templateCompressedLength);
  const templateQuery = zlib.inflateSync(templateBody.subarray(zlibOffset)).toString("utf8");
  const nextQuery = patchQuery(templateQuery, input.params);
  const compressed = zlib.deflateSync(Buffer.from(nextQuery, "utf8"));

  const body = Buffer.concat([
    replaceRouteBytes(
      patchEmbeddedCommonRestQueryLength(prefix, Buffer.byteLength(templateQuery, "utf8"), Buffer.byteLength(nextQuery, "utf8")),
      input.route
    ),
    u32be(Buffer.byteLength(nextQuery, "utf8")),
    u32be(compressed.length),
    compressed,
    suffix
  ]);

  return encodeFrame(input.session, input.status, body);
}

function buildTemplateSendFrame(input: {
  template: Buffer;
  session: Buffer;
  route?: Buffer;
  status: number;
  params: DirectTemplateParams;
}) {
  try {
    return buildRequestFrame(input);
  } catch {
    const { body } = getDirectTemplateBody(input.template);
    return encodeFrame(input.session, input.status, patchLengthPrefixedTemplateFields(replaceRouteBytes(body, input.route), input.params));
  }
}

function buildCommonRestRequestFrame(input: {
  template: Buffer;
  session: Buffer;
  route?: Buffer;
  status: number;
  apiName: string;
  query: string;
}) {
  const { body: templateBody } = getDirectTemplateBody(input.template);
  const zlibOffset = findZlibOffset(templateBody);
  if (zlibOffset < 8) {
    throw new Error("Common REST template body does not contain a zlib payload");
  }

  const templateCompressedLength = templateBody.readUInt32BE(zlibOffset - 4);
  const suffix = templateBody.subarray(zlibOffset + templateCompressedLength);
  const templateQuery = zlib.inflateSync(templateBody.subarray(zlibOffset)).toString("utf8");
  const compressed = zlib.deflateSync(Buffer.from(input.query, "utf8"));
  const prefix = patchEmbeddedCommonRestPayloadLength(
    patchEmbeddedCommonRestQueryLength(
      replaceCommonRestApiName(Buffer.from(templateBody.subarray(0, zlibOffset - 8)), input.apiName),
      Buffer.byteLength(templateQuery, "utf8"),
      Buffer.byteLength(input.query, "utf8")
    ),
    input.apiName,
    compressed.length
  );
  const body = Buffer.concat([
    replaceRouteBytes(prefix, input.route),
    u32be(Buffer.byteLength(input.query, "utf8")),
    u32be(compressed.length),
    compressed,
    suffix
  ]);

  return encodeFrame(input.session, input.status, body);
}

function replaceCommonRestApiName(prefix: Buffer, apiName: string) {
  const sourceApiName = "/pstn/share/getPrivateNumber";
  const sourceBytes = Buffer.from(sourceApiName, "utf8");
  const targetBytes = Buffer.from(apiName, "utf8");
  const index = prefix.indexOf(sourceBytes);
  if (index < 4) {
    throw new Error(`Common REST template does not contain API name ${sourceApiName}`);
  }
  const lengthOffset = index - 4;
  if (prefix.readUInt32BE(lengthOffset) !== sourceBytes.length) {
    throw new Error("Common REST API name length prefix is invalid");
  }
  return Buffer.concat([prefix.subarray(0, lengthOffset), u32be(targetBytes.length), targetBytes, prefix.subarray(index + sourceBytes.length)]);
}

function patchEmbeddedCommonRestPayloadLength(prefix: Buffer, apiName: string, compressedLength: number) {
  const apiBytes = Buffer.from(apiName, "utf8");
  const index = prefix.indexOf(apiBytes);
  if (index < 13) {
    return prefix;
  }

  const apiLengthOffset = index - 4;
  const payloadLengthOffset = apiLengthOffset - 9;
  if (prefix.readUInt32BE(apiLengthOffset) !== apiBytes.length) {
    return prefix;
  }

  const patched = Buffer.from(prefix);
  u32be(apiBytes.length + compressedLength + 21).copy(patched, payloadLengthOffset);
  return patched;
}

function patchEmbeddedCommonRestQueryLength(prefix: Buffer, oldLength: number, newLength: number) {
  if (oldLength === newLength) {
    return prefix;
  }
  const patched = Buffer.from(prefix);
  for (let index = 0; index <= patched.length - 13; index += 1) {
    if (
      patched.readUInt32BE(index) === oldLength &&
      patched.readUInt32BE(index + 4) === 1 &&
      patched[index + 8] === 0x32 &&
      patched.readUInt32BE(index + 9) > 0
    ) {
      u32be(newLength).copy(patched, index);
      return patched;
    }
  }
  return patched;
}

function buildPreLoginBody(templateBody: Buffer, params: DirectTemplateParams) {
  const jsonStart = templateBody.indexOf(0x7b);
  const jsonEnd = templateBody.lastIndexOf(0x7d);
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error("Prelogin template does not contain JSON payload");
  }

  const prefix = templateBody.subarray(0, jsonStart - 1);
  const suffix = templateBody.subarray(jsonEnd + 1);
  const payload = {
    deviceID: String(params.deviceID ?? ""),
    notPreLogin: "true",
    userID: Number(params.userID ?? 0)
  };
  const jsonBytes = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([prefix, Buffer.from([jsonBytes.length]), jsonBytes, suffix]);
}

function buildLoginInitPacket(input: {
  session: Buffer;
  route: Buffer;
  runtime: DirectRuntimeConfig;
  account: { dtUserId: string; token: string; deviceId?: string | null; email?: string | null };
  loginTrackCode: string;
  configTrackCode: string;
}) {
  const frames = splitTemplateFrames(LOGIN_INIT_PACKET);
  const loginFrame = frames[0];
  const configFrame = frames[1];
  if (!loginFrame || !configFrame) {
    throw new Error("Login bootstrap template is incomplete");
  }

  const deviceId = accountDeviceId(input.account);
  const routeParams = routeQueryParams(input.route);
  const loginBody = buildLoginInitBody(loginFrame, input.route, {
    deviceId,
    userId: input.account.dtUserId,
    token: input.account.token,
    email: input.account.email?.trim() || CAPTURED_LOGIN_FIELDS.email,
    trackCode: input.loginTrackCode,
    magic: routeParams.magic,
    wSite: routeParams.wSite,
    dwHost: routeParams.dwHost,
    xip: routeParams.xip,
    appId: resolveDirectAccountAppId(deviceId),
    apkCertificateSign: resolveDirectAccountApkCertificateSign(deviceId, input.runtime.apkCertificateSign)
  });
  const configRequest = buildRequestFrame({
    template: configFrame,
    session: input.session,
    route: input.route,
    status: 0x0102,
    params: {
      deviceId,
      TrackCode: input.configTrackCode,
      appId: "",
      clientVersion: "",
      appVersion: input.runtime.appVersion,
      apkCertificateSign: input.runtime.apkCertificateSign
    }
  });

  return Buffer.concat([encodeFrame(input.session, 0x0102, loginBody), configRequest]);
}

function buildLoginInitBody(
  templateFrame: Buffer,
  route: Buffer,
  params: {
    deviceId: string;
    userId: string;
    token: string;
    email: string;
    trackCode: string;
    magic?: string | number | boolean;
    wSite?: string | number | boolean;
    dwHost?: string | number | boolean;
    xip?: string | number | boolean;
    appId: string;
    apkCertificateSign: string;
  }
) {
  let body = replaceRouteBytes(Buffer.from(templateFrame.subarray(22)), route);
  body = replaceLengthPrefixedAscii(body, CAPTURED_LOGIN_FIELDS.deviceId, params.deviceId);
  body = replaceLengthPrefixedAscii(body, CAPTURED_LOGIN_FIELDS.userId, params.userId);
  body = replaceLengthPrefixedAscii(body, CAPTURED_LOGIN_FIELDS.token, params.token);
  body = replaceLengthPrefixedAscii(body, CAPTURED_LOGIN_FIELDS.email, params.email);

  const queryStart = body.indexOf(Buffer.from("deviceId="));
  if (queryStart < 4) {
    throw new Error("Login bootstrap template does not contain its plain query");
  }
  const queryLengthOffset = queryStart - 4;
  const queryLength = body.readUInt32BE(queryLengthOffset);
  const queryEnd = queryStart + queryLength;
  if (queryEnd > body.length) {
    throw new Error("Login bootstrap plain query length is invalid");
  }

  const templateQuery = body.subarray(queryStart, queryEnd).toString("utf8");
  const nextQuery = patchLoginBootstrapQuery(templateQuery, {
    deviceId: params.deviceId,
    userId: params.userId,
    token: params.token,
    TrackCode: params.trackCode,
    magic: params.magic,
    wSite: params.wSite,
    dwHost: params.dwHost,
    xip: params.xip,
    appId: params.appId,
    apkCertificateSign: params.apkCertificateSign
  });
  const nextQueryBytes = Buffer.from(nextQuery, "utf8");
  return Buffer.concat([
    body.subarray(0, queryLengthOffset),
    u32be(nextQueryBytes.length),
    nextQueryBytes,
    body.subarray(queryEnd)
  ]);
}

function splitTemplateFrames(buffer: Buffer) {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 6 || buffer[offset] !== 0x01 || buffer[offset + 1] !== 0x07) {
      throw new Error("Captured template contains an invalid frame boundary");
    }
    const totalLen = buffer.readUInt32BE(offset + 2);
    if (totalLen < 12 || offset + totalLen > buffer.length) {
      throw new Error("Captured template contains an invalid frame length");
    }
    frames.push(buffer.subarray(offset, offset + totalLen));
    offset += totalLen;
  }
  return frames;
}

function replaceLengthPrefixedAscii(buffer: Buffer, search: string, replacement: string) {
  const searchBytes = Buffer.from(search, "utf8");
  const replacementBytes = Buffer.from(replacement, "utf8");
  let current = Buffer.from(buffer);
  let offset = 0;

  while (offset <= current.length - searchBytes.length) {
    const index = current.indexOf(searchBytes, offset);
    if (index < 0) {
      break;
    }
    const lengthOffset = index - 4;
    if (lengthOffset < 0 || current.readUInt32BE(lengthOffset) !== searchBytes.length) {
      offset = index + 1;
      continue;
    }
    current = Buffer.concat([
      current.subarray(0, lengthOffset),
      u32be(replacementBytes.length),
      replacementBytes,
      current.subarray(index + searchBytes.length)
    ]);
    offset = lengthOffset + 4 + replacementBytes.length;
  }

  return current;
}

function patchLengthPrefixedTemplateFields(buffer: Buffer, params: DirectTemplateParams) {
  let current = Buffer.from(buffer);
  const replacements: Array<[string, string | number | boolean | undefined]> = [
    [CAPTURED_LOGIN_FIELDS.deviceId, params.deviceId],
    [CAPTURED_OFFLINE_FIELDS.deviceId, params.deviceId],
    [CAPTURED_LOGIN_FIELDS.userId, params.userId ?? params.dtUserId],
    [CAPTURED_LOGIN_FIELDS.token, params.token],
    [CAPTURED_LOGIN_FIELDS.email, params.email]
  ];

  for (const [search, replacement] of replacements) {
    if (replacement === undefined) {
      continue;
    }
    current = replaceLengthPrefixedAscii(current, search, String(replacement));
  }
  return current;
}

function encodeFrame(session: Buffer, status: number, body: Buffer) {
  const totalLen = 22 + body.length;
  const frame = Buffer.alloc(totalLen);
  frame.set(Buffer.from([0x01, 0x07]), 0);
  frame.writeUInt32BE(totalLen, 2);
  frame.writeUInt16BE(0x8107, 6);
  session.copy(frame, 8);
  frame.writeUInt32BE(body.length + 6, 12);
  frame.writeUInt16BE(status, 16);
  frame.writeUInt32BE(body.length + 6, 18);
  body.copy(frame, 22);
  return frame;
}

function buildPushAckFrame(frame: ParsedFrame) {
  if (frame.type !== 0x8107 || frame.status !== 0x0103 || frame.body.length < 32) {
    return null;
  }

  const sourceRoute = frame.body.subarray(0, 8);
  const destinationRoute = frame.body.subarray(8, 16);
  const ackTail = Buffer.from(frame.body.subarray(16, 32));
  ackTail[0] = 0x14;
  ackTail[7] = 0x04;
  return encodeFrame(frame.session, 0x0103, Buffer.concat([destinationRoute, sourceRoute, ackTail]));
}

function buildPushDeliveryConfirmFrame(frame: ParsedFrame, account: Pick<DirectSessionAccount, "dtUserId" | "deviceId">, serial: number) {
  if (frame.type !== 0x8107 || frame.status !== 0x0103 || frame.body.length < 40) {
    return null;
  }

  const sourceRoute = frame.body.subarray(0, 8);
  const destinationRoute = frame.body.subarray(8, 16);
  const pushTail = frame.body.subarray(28, 32);
  const deviceId = accountDeviceId(account);
  const messageId = frame.body.readBigUInt64BE(32).toString();
  const deviceBytes = Buffer.from(deviceId, "utf8");
  const messageIdBytes = Buffer.from(messageId, "utf8");
  if (deviceBytes.length > 0xff) {
    return null;
  }
  const deliveryPayloadLength = 4 + 1 + deviceBytes.length + 4 + messageIdBytes.length + 8;

  const deliveryBlock = Buffer.concat([
    u32be(18),
    u32be(deliveryPayloadLength),
    u32be(0),
    Buffer.from([deviceBytes.length]),
    deviceBytes,
    u32be(messageIdBytes.length),
    messageIdBytes,
    Buffer.from([0x00, 0x08, 0x00, 0x00]),
    pushTail
  ]);

  return encodeFrame(
    frame.session,
    0x0102,
    Buffer.concat([
      destinationRoute,
      sourceRoute,
      Buffer.from("0c07000000000100", "hex"),
      u24be(serial),
      lengthPrefixedBuffer(dottedRoute(destinationRoute)),
      lengthPrefixedBuffer(dottedRoute(sourceRoute)),
      deliveryBlock
    ])
  );
}

function u32be(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function u24be(value: number) {
  const buffer = Buffer.alloc(3);
  buffer.writeUIntBE(Math.max(0, value) & 0xffffff, 0, 3);
  return buffer;
}

function lengthPrefixedBuffer(value: Buffer) {
  return Buffer.concat([u32be(value.length), value]);
}

function patchQuery(templateQuery: string, params: DirectTemplateParams) {
  const entries = templateQuery.split("&");
  const replacements = new Map<string, string>();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    replacements.set(key.toLowerCase(), String(value));
  }

  const output: string[] = [];
  for (const entry of entries) {
    if (!entry.includes("=")) {
      output.push(entry);
      continue;
    }
    const [key = "", ...rest] = entry.split("=");
    const value = rest.join("=");
    const replacement = replacements.get(key.toLowerCase());
    if (replacement === undefined) {
      output.push(`${key}=${value}`);
      continue;
    }
    output.push(`${key}=${encodeURIComponent(replacement)}`);
  }
  return output.join("&");
}

function patchLoginBootstrapQuery(templateQuery: string, params: DirectTemplateParams) {
  const patched = patchQuery(templateQuery, params);
  return patched
    .split("&")
    .map((entry) => patchLoginBootstrapQueryEntry(entry, params))
    .join("&");
}

function patchLoginBootstrapQueryEntry(entry: string, params: DirectTemplateParams) {
  if (!entry.includes("=")) {
    return entry;
  }
  const [key = "", ...rest] = entry.split("=");
  const value = rest.join("=");
  if (key.toLowerCase() !== "clientinfo") {
    return entry;
  }
  const parsed = parseEncodedJsonObject(value);
  if (!parsed) {
    return entry;
  }
  if (typeof params.appId === "string" && params.appId.trim()) {
    parsed.appId = params.appId.trim();
  }
  if (typeof params.apkCertificateSign === "string" && params.apkCertificateSign.trim()) {
    parsed.signMd5 = params.apkCertificateSign.trim();
  }
  if (!parsed.pingTime) {
    parsed.pingTime = "100000;100000";
  }
  return `${key}=${encodeURIComponent(JSON.stringify(parsed))}`;
}

function parseEncodedJsonObject(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    const parsed = JSON.parse(decoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildRequestPrivateNumberQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  runtime: DirectRuntimeConfig,
  requestConfig: PrivatePhoneRequestConfig,
  trackCode: string,
  options: PrivatePhoneRequestQueryOptions = {}
) {
  const providerKey = options.providerKey ?? "providerList";
  const providerIdList = options.providerIdList?.length ? options.providerIdList : requestConfig.providerIdList;
  const query = [
    queryPair("countryCode", requestConfig.countryCode),
    queryPair(providerKey, providerIdList.join(",")),
    queryPair("isoCountryCode", requestConfig.isoCountryCode),
    queryPair("clientversion", runtime.appVersion),
    queryPair("supportCA", 1),
    queryPair("useStateCity", 0),
    queryPair("apiVersion", options.apiVersion ?? 5),
    queryPair("forceCheckNearByType", 0),
    queryPair("needToPay", true)
  ];

  if (options.includeAppRequestFields) {
    query.push(
      queryPair("balance", 0),
      queryPair("npanxx", -1),
      queryPair("nearByareaCodeList", buildNearbyAreaCodeList(requestConfig, options.areaCode)),
      queryPair("state", ""),
      queryPair("city", "")
    );
  }

  if (options.areaCode && options.areaCode > 0) {
    query.splice(1, 0, queryPair("areaCode", options.areaCode));
  } else if (options.includeZeroAreaCode) {
    query.splice(1, 0, queryPair("areaCode", 0));
  }

  if (options.includeAppContext ?? true) {
    query.unshift(
      queryPair("deviceId", accountDeviceId(account)),
      queryPair("TrackCode", trackCode),
      queryPair("clientVersion", runtime.appVersion),
      queryPair("appVersion", runtime.appVersion),
      queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign)),
      queryPair("userId", account.dtUserId),
      queryPair("token", account.token)
    );
  }

  const joined = query.join("&");
  return options.leadingAmpersand ? `&${joined}` : joined;
}

function buildGetNumberCountriesQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  runtime: DirectRuntimeConfig,
  trackCode: string
) {
  return [
    queryPair("deviceId", accountDeviceId(account)),
    queryPair("TrackCode", trackCode),
    queryPair("apiVersion", 2),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(accountDeviceId(account), runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function buildGlbUserPropertiesQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  runtime: DirectRuntimeConfig,
  trackCode: string
) {
  const deviceId = accountDeviceId(account);
  return [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", trackCode),
    "",
    queryPair("userId", account.dtUserId),
    queryPair("property", "inviteGroup_1"),
    queryPair("type", 1),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(deviceId, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function buildGwebInfoBusQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  runtime: DirectRuntimeConfig,
  trackCode: string
) {
  const deviceId = accountDeviceId(account);
  return [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", trackCode),
    "",
    queryPair("appId", resolveDirectGwebAppId(deviceId)),
    queryPair("storeID", 2),
    queryPair("countryCode", 86),
    queryPair("clientVersion", runtime.appVersion),
    queryPair("isoCC", "CN"),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(deviceId, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function resolveDirectGwebAppId(deviceId: string) {
  return isTalkUDeviceId(deviceId) ? "TU" : "DT";
}

function buildRequestPrivateNumberQueryAttempts(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  runtime: DirectRuntimeConfig,
  requestConfig: PrivatePhoneRequestConfig,
  trackCode: string,
  requestedAreaCode?: number | null
) {
  const areaCodes = resolvePreviewAreaCodeAttempts(requestConfig, requestedAreaCode);
  const baseVariants: PrivatePhoneRequestQueryOptions[] = [
    { apiVersion: 1, providerKey: "providerList", includeAppContext: true, includeZeroAreaCode: true, includeAppRequestFields: true },
    { apiVersion: 1, providerKey: "providerIdList", includeAppContext: true, includeZeroAreaCode: true, includeAppRequestFields: true },
    { apiVersion: 5, providerKey: "providerList", includeAppContext: false, leadingAmpersand: true },
    { apiVersion: 5, providerKey: "providerList", includeAppContext: true, includeZeroAreaCode: true },
    { apiVersion: 5, providerKey: "providerList", includeAppContext: true },
    { apiVersion: 0, providerKey: "providerList", includeAppContext: true },
    { apiVersion: 0, providerKey: "providerIdList", includeAppContext: true },
    { apiVersion: 1, providerKey: "providerList", includeAppContext: true },
    { apiVersion: 5, providerKey: "providerList", includeAppContext: false },
    { apiVersion: 5, providerKey: "providerIdList", includeAppContext: false, leadingAmpersand: true }
  ];
  const singleProviderVariants = requestConfig.providerIdList.flatMap((providerId) => [
    { apiVersion: 1, providerKey: "providerList" as const, providerIdList: [providerId], includeAppContext: true, includeZeroAreaCode: true, includeAppRequestFields: true },
    { apiVersion: 5, providerKey: "providerList" as const, providerIdList: [providerId], includeAppContext: false, leadingAmpersand: true },
    { apiVersion: 5, providerKey: "providerList" as const, providerIdList: [providerId], includeAppContext: true },
    { apiVersion: 5, providerKey: "providerIdList" as const, providerIdList: [providerId], includeAppContext: true },
    { apiVersion: 0, providerKey: "providerList" as const, providerIdList: [providerId], includeAppContext: true }
  ]);
  const variants = [...baseVariants, ...singleProviderVariants];
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const areaCode of areaCodes) {
    for (const variant of variants) {
      const query = buildRequestPrivateNumberQuery(account, runtime, requestConfig, trackCode, {
        ...variant,
        areaCode
      });
      if (!seen.has(query)) {
        seen.add(query);
        queries.push(query);
      }
    }
  }
  return queries;
}

function resolvePreviewAreaCodeAttempts(requestConfig: PrivatePhoneRequestConfig, requestedAreaCode?: number | null) {
  if (requestedAreaCode && requestedAreaCode > 0) {
    return [requestedAreaCode, 0];
  }
  if (requestConfig.randomAreaCodes?.length) {
    return [...shuffleAreaCodes(requestConfig.randomAreaCodes), 0];
  }
  return [0];
}

function buildNearbyAreaCodeList(requestConfig: PrivatePhoneRequestConfig, selectedAreaCode?: number | null) {
  const values = [
    ...(selectedAreaCode && selectedAreaCode > 0 ? [selectedAreaCode] : []),
    ...(requestConfig.randomAreaCodes ?? [])
  ];
  return [...new Set(values.filter((item) => Number.isInteger(item) && item > 0))].join(",");
}

function applyPreviewAttemptAreaCode(preview: DingtonePhonePurchasePreview, query: string): DingtonePhonePurchasePreview {
  const areaCode = parsePositiveQueryNumber(query, "areaCode");
  if (!areaCode) {
    return preview;
  }
  return {
    ...preview,
    candidates: preview.candidates.map((candidate) => ({
      ...candidate,
      areaCode: candidate.areaCode ?? areaCode
    }))
  };
}

function parsePositiveQueryNumber(query: string, key: string) {
  const value = new URLSearchParams(query.replace(/^&+/, "")).get(key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function shuffleAreaCodes(areaCodes: number[]) {
  const items = [...new Set(areaCodes.filter((item) => Number.isInteger(item) && item > 0))];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex]!, items[index]!];
  }
  return items;
}

function resolvePhoneActionApiName(label: DirectPhoneActionLabel, settings: Record<string, string>) {
  const mapping = {
    purchasePhone: {
      key: "dt_direct_api_purchase_phone",
      fallback: "/pstn/share/orderPrivateNumber"
    },
    renewPhone: {
      key: "dt_direct_api_renew_phone",
      fallback: "/pstn/share/orderPrivateNumber"
    },
    cancelPhone: {
      key: "dt_direct_api_cancel_phone",
      fallback: "/pstn/share/deletePhoneNumber"
    },
    pausePhone: {
      key: "dt_direct_api_pause_phone",
      fallback: "/pstn/share/privateNumberSetting"
    },
    resumePhone: {
      key: "dt_direct_api_resume_phone",
      fallback: "/pstn/share/privateNumberSetting"
    },
    updatePhoneLabel: {
      key: "dt_direct_api_phone_setting",
      fallback: "/pstn/share/privateNumberSetting"
    },
    clearPhoneLabel: {
      key: "dt_direct_api_phone_setting",
      fallback: "/pstn/share/privateNumberSetting"
    }
  } as const;
  const item = mapping[label];
  const configured = settings[item.key]?.trim();
  return normalizeDirectPhoneApiName(label, configured || item.fallback);
}

function normalizeDirectPhoneApiName(label: DirectPhoneActionLabel, apiName: string) {
  if (label === "cancelPhone" && /\/?pstn\/share\/deletePrivateNumber/i.test(apiName)) {
    return "/pstn/share/deletePhoneNumber";
  }
  return apiName;
}

function buildPhoneActionDryRun(
  label: DirectPhoneActionLabel,
  settings: Record<string, string>,
  query: string
): DirectPhoneActionDryRun {
  const apiName = resolvePhoneActionApiName(label, settings);
  const redactedQuery = redactDirectActionQuery(query);
  return {
    label,
    apiName,
    query: redactedQuery,
    params: queryStringToRecord(redactedQuery)
  };
}

function redactDirectActionQuery(query: string) {
  const params = new URLSearchParams(query);
  if (params.has("token")) {
    params.set("token", redactSecret(params.get("token") ?? ""));
  }
  return params.toString();
}

function queryStringToRecord(query: string) {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    params[key] = value;
  }
  return params;
}

function redactSecret(value: string) {
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function buildOrderPrivateNumberQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  phone: DirectPhoneActionContext,
  options: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; payFlag: number }
) {
  const raw = collectPhoneActionRecords(phone);
  const candidateCountryCode = options.countryCode ?? pickPhoneNumber(phone, raw, ["countryCode", "country_code"]) ?? 1;
  const isoCountryCode = options.isoCountryCode ?? pickPhoneString(phone, raw, ["isoCountryCode", "iso_country_code", "isoCC", "iso_cc"]);
  const countryKey = options.countryKey ?? pickPhoneString(phone, raw, ["countryKey", "country_key"]);
  const requestConfig = resolvePrivatePhoneRequestConfig(candidateCountryCode, isoCountryCode, countryKey);
  const countryCode = requestConfig.countryCode;
  const areaCode = resolvePhoneActionAreaCode(phone, {
    countryCode,
    isoCountryCode,
    countryKey,
    requestConfig
  });
  const phoneType =
    pickPhoneNumber(phone, raw, ["phoneType", "phone_type", "payType", "pay_type", "purchaseType", "purchase_type"]) ?? 2;
  const providerId = pickPhoneNumber(phone, raw, ["providerId", "provider_id", "reserved3"]) ?? resolveDefaultProviderId(countryCode, isoCountryCode, countryKey);
  const packageServiceId =
    pickPhoneString(phone, raw, ["packageServiceId", "package_service_id", "reserved4"]) ??
    requestConfig.packageServiceId ??
    resolvePackageServiceId(countryCode, providerId, isoCountryCode, countryKey);
  const payType = pickPhoneNumber(phone, raw, ["payType", "pay_type"]);
  const specialNumber =
    options.payFlag === 3
      ? resolveRenewSpecialNumberType(payType)
      : pickPhoneNumber(phone, raw, ["category", "specialNumberType", "special_number_type", "purchaseType", "purchase_type"]) ?? 0;
  const orderPhoneType = resolveOrderPrivateNumberType(options.payFlag, phone.status, phoneType);
  const orderPhoneNumber = stripPhonePrefix(phone.phoneNumber ?? "");
  const productId = pickPhoneString(phone, raw, ["productId", "product_id"]);
  const simCountryCode = pickPhoneString(phone, raw, ["simCC", "sim_cc"]);

  const query = [
    queryPair("token", account.token),
    queryPair("deviceId", accountDeviceId(account)),
    queryPair("userId", account.dtUserId),
    queryPair("countryCode", requestConfig.countryCode),
    queryPair("areaCode", areaCode),
    queryPair("phoneNumber", orderPhoneNumber),
    queryPair("type", orderPhoneType),
    queryPair("payFlag", options.payFlag),
    queryPair("payYears", 1),
    queryPair("specialNumber", specialNumber),
    ...(options.payFlag === 2 ? [] : [queryPair("coupon", "")]),
    ...(options.payFlag === 2 ? [] : [queryPair("callplanId", pickPhoneNumber(phone, raw, ["callPlanId", "callplanId", "call_plan_id"]) ?? 0)]),
    ...(options.payFlag === 2 ? [] : [queryPair("oldPhoneNum", "")]),
    queryPair("providerId", providerId),
    queryPair("packageServiceId", packageServiceId),
    ...(simCountryCode ? [queryPair("simCC", simCountryCode)] : []),
    queryPair("simu", pickPhoneBoolean(phone, raw, ["isSimulator", "simulator", "simu"]) ? 1 : 0),
    queryPair("apiVersion", options.payFlag === 2 ? 3 : 4),
    "buyCredit=1",
    ...(options.payFlag === 2 && productId ? [queryPair("productId", productId)] : [])
  ];
  return query.join("&");
}

function buildOrderPrivateNumberQueryAttempts(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  phone: DirectPhoneActionContext,
  options: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; payFlag: number }
) {
  const base = buildOrderPrivateNumberQuery(account, phone, options);
  const params = new URLSearchParams(base);
  const appShape = new URLSearchParams(params);
  appShape.delete("apiVersion");
  const nativeShape = new URLSearchParams(params);
  nativeShape.set("privateNumber", params.get("phoneNumber") ?? stripPhonePrefix(phone.phoneNumber ?? ""));
  const leadingAmpersand = `&${appShape.toString()}`;
  return uniqueStrings([base, appShape.toString(), nativeShape.toString(), leadingAmpersand]);
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveOrderPrivateNumberType(payFlag: number, status: DirectPhoneActionContext["status"], fallbackPhoneType: number) {
  if (payFlag === 3) {
    return 0;
  }
  if (payFlag === 2 && status === "expired") {
    return 2;
  }
  return fallbackPhoneType;
}

function resolveRenewSpecialNumberType(payType: number | undefined) {
  if (payType === 8) {
    return 2;
  }
  return payType === 5 || payType === 6 ? 1 : 0;
}

function buildDeletePrivateNumberQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  phoneNumber: string
) {
  const strippedPhoneNumber = stripPhonePrefix(phoneNumber);
  return [
    queryPair("token", account.token),
    queryPair("deviceId", accountDeviceId(account)),
    queryPair("userId", account.dtUserId),
    queryPair("phoneNumber", strippedPhoneNumber),
    queryPair("privateNumber", strippedPhoneNumber)
  ].join("&");
}

function buildReactivateGoogleVoiceNumberQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  phoneNumber: string
) {
  return [
    queryPair("token", account.token),
    queryPair("deviceId", accountDeviceId(account)),
    queryPair("userId", account.dtUserId),
    queryPair("phoneNumber", stripPhonePrefix(phoneNumber))
  ].join("&");
}

function buildPrivateNumberSettingQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  phone: DirectPhoneActionContext,
  suspendFlag: 0 | 1
) {
  const setting = buildPrivateNumberSettingJson(phone, suspendFlag);
  return [
    queryPair("token", account.token),
    queryPair("deviceId", accountDeviceId(account)),
    queryPair("userId", account.dtUserId),
    queryPair("json", JSON.stringify(setting))
  ].join("&");
}

function buildPrivateNumberSettingJson(phone: DirectPhoneActionContext, suspendFlag: 0 | 1) {
  const raw = collectPhoneActionRecords(phone);
  const silentFlag = pickPhoneBoolean(phone, raw, ["silentFlag", "silent_flag"]);
  const isSuspending = suspendFlag === 1;
  const primaryFlag = isSuspending ? false : (pickPhoneBoolean(phone, raw, ["isPrimary", "primaryFlag", "primary_flag"]) ?? true);
  const callForwardFlag = pickPhoneBoolean(phone, raw, ["callForwardFlag", "call_forward_flag"]);
  const autoRenew = pickPhoneBoolean(phone, raw, ["autoRenew", "auto_renew"]) ?? true;
  const filterSetting = {
    ...parsePrivateNumberFilterSetting(pickPhoneString(phone, raw, ["filterSetting", "filter_setting"])),
    allowReceiveSMS: true
  };
  return {
    phoneNumber: stripPhonePrefix(phone.phoneNumber ?? pickPhoneString(phone, raw, ["phoneNumber", "phone_number"]) ?? ""),
    displayName: phone.displayName ?? pickPhoneString(phone, raw, ["displayName", "display_name"]) ?? "",
    primaryFlag: booleanFlagNumber(primaryFlag),
    silentFlag: booleanFlagNumber(silentFlag),
    slientFlag: booleanFlagNumber(silentFlag),
    suspendFlag,
    callForwardFlag: booleanFlagNumber(callForwardFlag),
    forwardNumber: pickPhoneString(phone, raw, ["forwardNumber", "forward_number"]) ?? "",
    forwardCountryCode: pickPhoneNumber(phone, raw, ["forwardCountryCode", "forward_country_code"]) ?? 0,
    forwardDestCode: pickPhoneNumber(phone, raw, ["forwardDestCode", "forward_dest_code"]) ?? 0,
    autoSMSReply: pickPhoneNumber(phone, raw, ["autoSMSReply", "auto_sms_reply"]) ?? 0,
    useVoicemail: pickPhoneNumber(phone, raw, ["useVoicemail", "use_voicemail"]) ?? 0,
    voicemailId: pickPhoneString(phone, raw, ["voicemailId", "voicemail_id"]) ?? "",
    autoSMSContent: pickPhoneString(phone, raw, ["autoSMSContent", "auto_sms_content"]) ?? "",
    defaultGreetings: pickPhoneNumber(phone, raw, ["defaultGreetings", "default_greetings"]) ?? 0,
    autoRenew: autoRenew ? 1 : 0,
    filterSetting: JSON.stringify(filterSetting)
  };
}

function booleanFlagNumber(value: boolean | undefined) {
  return value ? 1 : 0;
}

function parsePrivateNumberFilterSetting(value?: string) {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildPhoneTemplateParams(phone: DirectPhoneActionContext, extraParams: DirectTemplateParams): DirectTemplateParams {
  const raw = collectPhoneActionRecords(phone);
  return {
    countryCode: pickPhoneNumber(phone, raw, ["countryCode", "country_code"]),
    areaCode: pickPhoneNumber(phone, raw, ["areaCode", "area_code"]),
    providerId: pickPhoneNumber(phone, raw, ["providerId", "provider_id", "reserved3"]),
    packageServiceId: pickPhoneString(phone, raw, ["packageServiceId", "package_service_id", "reserved4"]),
    category: pickPhoneNumber(phone, raw, ["category", "specialNumberType", "special_number_type", "purchaseType", "purchase_type"]),
    phoneType: pickPhoneNumber(phone, raw, ["phoneType", "phone_type", "payType", "pay_type"]),
    displayName: pickPhoneString(phone, raw, ["displayName", "display_name"]),
    autoRenew: pickPhoneBoolean(phone, raw, ["autoRenew", "auto_renew"]) ? 1 : 0,
    ...extraParams
  };
}

function collectPhoneActionRecords(phone: DirectPhoneActionContext) {
  const records: Record<string, unknown>[] = [];
  if (isRecord(phone)) {
    records.push(phone);
  }
  const parsed = parseJsonRecord(phone.rawJson);
  if (parsed) {
    records.push(...collectNestedRecords(parsed));
  }
  return records;
}

function pickPhoneString(phone: DirectPhoneActionContext, records: Record<string, unknown>[], keys: string[]) {
  return pickStringFromRecords([phone as Record<string, unknown>, ...records], keys);
}

function pickPhoneNumber(phone: DirectPhoneActionContext, records: Record<string, unknown>[], keys: string[]) {
  return pickNumberFromRecords([phone as Record<string, unknown>, ...records], keys);
}

function pickPhoneBoolean(phone: DirectPhoneActionContext, records: Record<string, unknown>[], keys: string[]) {
  for (const record of [phone as Record<string, unknown>, ...records]) {
    const value = pickBoolean(record, keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function parseJsonRecord(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resolveDefaultProviderId(countryCode: number, isoCountryCode?: string | null, countryKey?: string | null) {
  const provider = resolvePrivatePhoneRequestConfig(countryCode, isoCountryCode, countryKey).providerIdList[0];
  const parsed = provider ? Number(provider) : NaN;
  return Number.isFinite(parsed) ? parsed : 2000;
}

function resolvePackageServiceId(countryCode: number, providerId: number, isoCountryCode?: string | null, countryKey?: string | null) {
  const providerSpecific: Record<number, string> = {
    2000: "DT01001",
    2001: "DT02001",
    2002: "DT03001",
    2003: "DT03002",
    2004: "DT03003",
    2006: "DT03005",
    2007: "DT03006",
    2008: "DT03007",
    2030: "DT04001",
    2100: "DT03009",
    2300: "DT05001"
  };
  const countrySpecific: Record<number, string> = {
    7: "DT03002",
    31: "DT03005",
    32: "DT03001",
    33: "DT03009",
    34: "DT03003",
    40: "DT05009",
    43: "DT03008",
    44: providerId === 2300 ? "DT05001" : "DT02001",
    45: "DT05008",
    46: "DT03010",
    48: "DT05003",
    60: "DT05007",
    61: "DT03007",
    62: "DT05004",
    65: "DT03009",
    81: "DT03009",
    82: "DT03009",
    86: "DT04001",
    230: "DT03011",
    420: "DT05006",
    852: "DT03009",
    886: "DT03009",
    1787: "DT05005"
  };
  return resolvePrivatePhoneRequestConfig(countryCode, isoCountryCode, countryKey).packageServiceId ?? countrySpecific[countryCode] ?? providerSpecific[providerId] ?? "DT01001";
}

function guessAreaCode(phoneNumber: string | undefined, countryCode: number) {
  const digits = stripPhonePrefix(phoneNumber ?? "");
  const country = String(countryCode);
  const local = digits.startsWith(country) ? digits.slice(country.length) : digits;
  const area = Number(local.slice(0, 3));
  return Number.isFinite(area) ? area : 0;
}

function resolvePhoneActionAreaCode(
  phone: DirectPhoneActionContext,
  options: {
    countryCode?: number;
    isoCountryCode?: string | null;
    countryKey?: string | null;
    requestConfig?: PrivatePhoneRequestConfig;
  } = {}
) {
  const raw = collectPhoneActionRecords(phone);
  const explicit = pickPhoneNumber(phone, raw, ["areaCode", "area_code"]);
  if (explicit && explicit > 0) {
    return explicit;
  }
  const requestConfig =
    options.requestConfig ?? resolvePrivatePhoneRequestConfig(options.countryCode, options.isoCountryCode, options.countryKey);
  if (requestConfig.randomAreaCodes?.length) {
    const guessed = guessAreaCode(phone.phoneNumber, requestConfig.countryCode);
    if (guessed > 0) {
      return guessed;
    }
    return shuffleAreaCodes(requestConfig.randomAreaCodes)[0] ?? 0;
  }
  return 0;
}

function stripPhonePrefix(phoneNumber: string) {
  return phoneNumber.replace(/[^\d]/g, "");
}

function stripPhoneCountryPrefix(phoneNumber: string, countryCode: number | null | undefined) {
  const digits = stripPhonePrefix(phoneNumber);
  const prefix = countryCode ? String(countryCode) : "";
  if (prefix && digits.startsWith(prefix) && digits.length > prefix.length + 3) {
    return digits.slice(prefix.length);
  }
  return digits;
}

function resolvePrivatePhoneRequestConfig(countryCode?: number, isoCountryCode?: string | null, countryKey?: string | null): PrivatePhoneRequestConfig {
  const normalized = Number.isFinite(countryCode) && countryCode ? Number(countryCode) : 1;
  const normalizedIso = isoCountryCode?.trim().toUpperCase();
  const normalizedKey = countryKey?.trim().toUpperCase();
  if (normalizedKey) {
    const byKey = APP_PHONE_COUNTRY_CONFIGS.find((item) => item.countryKey === normalizedKey);
    if (byKey) {
      return byKey;
    }
  }
  if (normalizedIso) {
    const byIso = APP_PHONE_COUNTRY_CONFIGS.find((item) => item.countryCode === normalized && item.isoCountryCode === normalizedIso);
    if (byIso) {
      return byIso;
    }
  }
  const byCode = APP_PHONE_COUNTRY_CONFIGS.find((item) => item.countryCode === normalized);
  if (byCode) {
    return byCode;
  }
  return (
    {
      countryKey: resolveIsoCountryCode(normalized),
      label: `+${normalized}`,
      countryCode: normalized,
      isoCountryCode: resolveIsoCountryCode(normalized),
      providerIdList: ["2000"]
    }
  );
}

function resolveIsoCountryCode(countryCode: number) {
  const mapping: Record<number, string> = {
    1: "US",
    7: "RU",
    31: "NL",
    32: "BE",
    33: "FR",
    34: "ES",
    40: "RO",
    43: "AT",
    44: "GB",
    45: "DK",
    46: "SE",
    48: "PL",
    60: "MY",
    61: "AU",
    62: "ID",
    65: "SG",
    81: "JP",
    82: "KR",
    86: "CN",
    230: "MU",
    420: "CZ",
    852: "HK",
    886: "TW",
    1787: "PR"
  };
  return mapping[countryCode] ?? "US";
}

function buildRecoverPasswordQuery(kind: "email" | "phone", target: string, countryCode = 1, noCode = 0) {
  return [
    queryPair("json", buildAccessCodeJson(kind, target, countryCode)),
    queryPair("type", kind === "email" ? 1 : 2),
    queryPair("noCode", noCode)
  ].join("&");
}

function buildVerifyAccessCodeQuery(kind: "email" | "phone", target: string, countryCode = 1, accessCode: string | number) {
  return [
    queryPair("json", buildAccessCodeJson(kind, target, countryCode)),
    queryPair("type", kind === "email" ? 1 : 2),
    queryPair("accessCode", String(accessCode).trim())
  ].join("&");
}

export function inferAccessCodeCountryCode(target: string) {
  const digits = stripPhonePrefix(target);
  if (!digits) {
    return undefined;
  }
  const candidates = [
    1787,
    ...APP_PHONE_COUNTRY_CONFIGS.map((item) => item.countryCode),
    852,
    886,
    65,
    81,
    82
  ]
    .filter((item, index, list) => list.indexOf(item) === index)
    .sort((a, b) => String(b).length - String(a).length);
  const matched = candidates.find((countryCode) => digits.startsWith(String(countryCode)));
  if (!matched) {
    return undefined;
  }
  if (target.trim().startsWith("+")) {
    return matched;
  }
  return looksLikeInternationalPhoneDigits(digits, matched) ? matched : undefined;
}

function looksLikeInternationalPhoneDigits(digits: string, countryCode: number) {
  if (countryCode === 1) {
    return digits.length >= 11;
  }
  const countryLength = String(countryCode).length;
  const localLength = digits.length - countryLength;
  if (countryLength >= 4) {
    return localLength >= 7;
  }
  if (countryLength >= 3) {
    return localLength >= 7;
  }
  return localLength >= 9;
}

function resolveAccessCodeCountryCode(kind: "email" | "phone", target: string, countryCode?: number) {
  if (kind === "email") {
    return countryCode ?? 1;
  }
  return countryCode ?? inferAccessCodeCountryCode(target) ?? 1;
}

function assertValidAccessCodeTarget(kind: "email" | "phone", target: string) {
  if (kind === "email") {
    const trimmed = target.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      throw new AppError("Invalid email target for access-code probe", 400, 400);
    }
    return;
  }
  const digits = stripPhonePrefix(target);
  if (digits.length < 7 || digits.length > 15) {
    throw new AppError("Invalid phone target for access-code probe", 400, 400);
  }
}

function buildAccessCodeJson(kind: "email" | "phone", target: string, countryCode = 1) {
  return JSON.stringify(
    kind === "email"
      ? { email: target }
      : {
          countryCode,
          phoneNumber: stripPhonePrefix(target)
        }
  );
}

function parseQueryParams(query: string) {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    params[key] = value;
  }
  return params;
}

function redactAccessCodeTarget(kind: "email" | "phone", target: string) {
  if (kind === "email") {
    const [name = "", domain = ""] = target.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return target.replace(/(\d{2})\d+(\d{2})$/, "$1***$2");
}

function queryPair(key: string, value: string | number | boolean) {
  return `${key}=${encodeURIComponent(String(value)).replace(/%2C/gi, ",")}`;
}

function replaceRouteBytes(prefix: Buffer, route?: Buffer) {
  if (!route) {
    return prefix;
  }
  const oldRoute = prefix.subarray(0, 8);
  const patched = Buffer.from(prefix);
  replaceAll(patched, oldRoute, route);
  replaceAll(patched, dottedRoute(oldRoute), dottedRoute(route));
  return patched;
}

function replaceAll(buffer: Buffer, search: Buffer, replace: Buffer) {
  if (search.length !== replace.length) {
    return;
  }
  let offset = 0;
  while (offset <= buffer.length - search.length) {
    const index = buffer.indexOf(search, offset);
    if (index < 0) {
      break;
    }
    replace.copy(buffer, index);
    offset = index + search.length;
  }
}

function dottedRoute(route: Buffer) {
  const parts: string[] = [];
  for (let index = 0; index < route.length; index += 1) {
    const byte = route[index];
    if (byte === undefined) {
      continue;
    }
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return Buffer.from(parts.join("."));
}

function routeQueryParams(route?: Buffer): DirectTemplateParams {
  if (!route || route.length < 8) {
    return {};
  }
  return {
    magic: route.readUInt16BE(0),
    wSite: route.readUInt16BE(2),
    dwHost: route.readUInt32BE(4),
    xip: dottedRoute(route).toString("utf8")
  };
}

function findZlibOffset(buffer: Buffer) {
  for (let index = 0; index < buffer.length - 1; index += 1) {
    const current = buffer[index];
    const next = buffer[index + 1];
    if (current === 0x78 && next !== undefined && [0x01, 0x9c, 0xda].includes(next)) {
      return index;
    }
  }
  return -1;
}

function parseFrame(raw: Buffer): ParsedFrame {
  const type = raw.readUInt16BE(6);
  const session = raw.subarray(8, 12);
  const body = raw.subarray(22);
  return {
    raw,
    type,
    session,
    status: type === 0x8107 && raw.length >= 18 ? raw.readUInt16BE(16) : undefined,
    route: type === 0x8107 && body.length >= 16 ? body.subarray(8, 16) : undefined,
    body
  };
}

function frameToDirectPush(frame: ParsedFrame): DirectProbePushResult {
  return {
    receivedAt: new Date().toISOString(),
    frameType: frame.type,
    status: frame.status,
    routeHex: frame.route?.toString("hex"),
    bodyLength: frame.body.length,
    rawHex: frame.raw.toString("hex"),
    bodyHex: frame.body.toString("hex"),
    rawHexPreview: frame.raw.subarray(0, 160).toString("hex"),
    bodyHexPreview: frame.body.subarray(0, 160).toString("hex"),
    jsonPayload: extractJsonPayload(frame.raw),
    sms: tryParseSmsPush(frame.raw) ?? tryParseSmsPush(frame.body)
  };
}

function extractJsonPayload(raw: Buffer): ApiResult | null {
  const payload = raw.subarray(22);
  const seen = new Set<string>();

  for (const candidate of extractStrings(payload)) {
    const trimmed = candidate.trim();
    const parsed = tryParseJsonObjectFromText(trimmed);
    if (!parsed) {
      continue;
    }
    const signature = JSON.stringify(parsed);
    if (!seen.has(signature)) {
      seen.add(signature);
      return parsed;
    }
  }

  for (const offset of findZlibOffsets(payload)) {
    try {
      const inflated = zlib.inflateSync(payload.subarray(offset)).toString("utf8").trim();
      if (inflated.startsWith("{") && inflated.endsWith("}")) {
        return JSON.parse(inflated) as ApiResult;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function summarizeJsonPayload(payload: ApiResult | null | undefined) {
  if (!payload) {
    return undefined;
  }

  const redacted = redactJsonPayload(payload);
  const text = JSON.stringify(redacted);
  if (text.length <= 600) {
    return text;
  }
  return `${text.slice(0, 600)}...`;
}

function redactJsonPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => redactJsonPayload(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
    if (/token|password|secret|credential|cookie|session/i.test(key)) {
      output[key] = "<redacted>";
      continue;
    }
    output[key] = redactJsonPayload(child);
  }
  return output;
}

function tryParseJsonObjectFromText(value: string): ApiResult | null {
  for (let start = value.indexOf("{"); start >= 0; start = value.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(value.slice(start, index + 1)) as ApiResult;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function tryParseSmsPush(payload: Buffer) {
  try {
    return parseSmsPush(payload);
  } catch {
    return null;
  }
}

function extractStrings(buffer: Buffer) {
  const strings: string[] = [];
  let current = "";
  for (const byte of buffer) {
    if (byte >= 32 && byte < 127) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length >= 4) {
      strings.push(current);
    }
    current = "";
  }
  if (current.length >= 4) {
    strings.push(current);
  }
  return strings;
}

function findZlibOffsets(buffer: Buffer) {
  const offsets: number[] = [];
  for (let index = 0; index < buffer.length - 1; index += 1) {
    const current = buffer[index];
    const next = buffer[index + 1];
    if (current === 0x78 && next !== undefined && [0x01, 0x9c, 0xda].includes(next)) {
      offsets.push(index);
    }
  }
  return offsets;
}

const APP_PHONE_COUNTRY_LABELS: Record<string, string> = {
  US: "美国 +1",
  CA: "加拿大 +1",
  GB: "英国 +44",
  BE: "比利时 +32",
  NL: "荷兰 +31",
  RU: "俄罗斯 +7",
  ES: "西班牙 +34",
  CN: "中国 +86",
  AU: "澳大利亚 +61",
  AT: "奥地利 +43",
  FR: "法国 +33",
  SE: "瑞典 +46",
  MU: "毛里求斯 +230",
  PL: "波兰 +48",
  ID: "印度尼西亚 +62",
  PR: "波多黎各 +1787",
  CZ: "捷克 +420",
  MY: "马来西亚 +60",
  DK: "丹麦 +45",
  RO: "罗马尼亚 +40"
};

const APP_PHONE_COUNTRY_DISPLAY_NAMES: Record<string, string> = {
  US: "美国",
  CA: "加拿大",
  GB: "英国",
  BE: "比利时",
  NL: "荷兰",
  RU: "俄罗斯",
  ES: "西班牙",
  CN: "中国",
  AU: "澳大利亚",
  AT: "奥地利",
  FR: "法国",
  SE: "瑞典",
  MU: "毛里求斯",
  PL: "波兰",
  ID: "印度尼西亚",
  PR: "波多黎各",
  CZ: "捷克",
  MY: "马来西亚",
  DK: "丹麦",
  RO: "罗马尼亚"
};

function staticPhoneCountryOptions(): DingtonePhoneCountryOption[] {
  return APP_PHONE_COUNTRY_CONFIGS.map((item) => ({
    countryKey: item.countryKey,
    label: `${APP_PHONE_COUNTRY_DISPLAY_NAMES[item.countryKey] ?? item.label} +${item.countryCode}`,
    countryCode: item.countryCode,
    isoCountryCode: item.isoCountryCode,
    providerIdList: item.providerIdList,
    available: true,
    rawJson: safeJsonStringify({
      source: "talku-apk-static",
      strictAppCountryList: true,
      note: "Panel country list is pinned to TalkU app packageServiceId/applyType countries. Remote-only countries are intentionally ignored.",
      countryKey: item.countryKey,
      countryCode: item.countryCode,
      isoCountryCode: item.isoCountryCode,
      providerIdList: item.providerIdList,
      packageServiceId: item.packageServiceId,
      applyType: item.applyType
    })
  }));
}

function orderPhoneCountryOptions(items: DingtonePhoneCountryOption[]) {
  const staticItems = staticPhoneCountryOptions();
  const remoteByKey = new Map(items.map((item) => [`${item.countryCode}:${item.isoCountryCode}`, item]));
  const merged = staticItems.map((staticItem) => {
    const item = remoteByKey.get(`${staticItem.countryCode}:${staticItem.isoCountryCode}`);
    return {
      ...staticItem,
      ...(item ?? {}),
      label: staticItem.label,
      providerIdList: item?.providerIdList?.length ? item.providerIdList : staticItem.providerIdList,
      available: item?.available ?? true,
      rawJson: safeJsonStringify({
        ...(parseJsonRecord(staticItem.rawJson) ?? {}),
        remoteCountry: parseJsonRecord(item?.rawJson),
        remoteEnriched: Boolean(item)
      })
    };
  });
  // The TalkU purchase UI exposes a curated country list. The direct API can
  // return backend-only countries that the app does not show, so keep the panel
  // aligned with the app by default and only use remote data to enrich known
  // app countries.
  return sortPhoneCountries(merged);
}

function normalizePhoneCountryOptions(value: unknown): DingtonePhoneCountryOption[] {
  const items = extractPhoneCountryItems(value);
  const output = new Map<string, DingtonePhoneCountryOption>();
  for (const item of items) {
    const record = isRecord(item) ? item : {};
    const rawCode = pickString(record, ["cc", "countryCode", "country_code", "code"]);
    const iso = normalizeCountryIso(rawCode, pickString(record, ["isoCountryCode", "iso_country_code", "isoCC", "iso_cc", "isocc"]));
    const countryCode = normalizeCountryDialCode(rawCode, pickNumber(record, ["countryCode", "country_code"]));
    if (!countryCode || !iso) {
      continue;
    }
    const config = resolvePrivatePhoneRequestConfig(countryCode, iso);
    const key = `${countryCode}:${iso}`;
    const name = pickString(record, ["countryName", "country_name", "name", "country"]) ?? config.label.replace(/\s*\+\d+$/, "");
    output.set(key, {
      countryKey: config.countryKey,
      label: `${name} +${countryCode}`,
      countryCode,
      isoCountryCode: iso,
      providerIdList: pickProviderIdList(record) ?? config.providerIdList,
      available: true,
      rawJson: safeJsonStringify(item)
    });
  }
  return output.size > 0 ? sortPhoneCountries(Array.from(output.values())) : [];
}

function pickProviderIdList(record: Record<string, unknown>) {
  const raw =
    record.providerIdList ??
    record.provider_id_list ??
    record.providerList ??
    record.provider_list ??
    record.providers ??
    record.providerIds;
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const normalized = values.map((item) => String(item).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function extractPhoneCountryItems(value: unknown) {
  const records = collectNestedRecords(value);
  const items: unknown[] = [];
  for (const record of records) {
    for (const key of ["recommend", "bestSell", "best_sell", "other", "countries", "countryList", "country_list", "list"]) {
      const valueAtKey = record[key];
      if (Array.isArray(valueAtKey)) {
        items.push(...valueAtKey);
      }
    }
  }
  return items;
}

function normalizeCountryIso(rawCode?: string, rawIso?: string) {
  if (rawCode?.trim().toUpperCase() === "1-CA") {
    return "CA";
  }
  const normalizedIso = rawIso?.trim().toUpperCase();
  if (normalizedIso) {
    return normalizedIso;
  }
  const dialCode = normalizeCountryDialCode(rawCode);
  return dialCode ? resolveIsoCountryCode(dialCode) : undefined;
}

function normalizeCountryDialCode(rawCode?: string, rawNumber?: number) {
  if (rawCode?.trim().toUpperCase() === "1-CA") {
    return 1;
  }
  const parsed = rawCode ? Number(rawCode.replace(/[^\d]/g, "")) : rawNumber;
  return Number.isFinite(parsed) && parsed ? Number(parsed) : undefined;
}

function sortPhoneCountries(items: DingtonePhoneCountryOption[]) {
  const order = new Map(APP_PHONE_COUNTRY_CONFIGS.map((item, index) => [`${item.countryCode}:${item.isoCountryCode}`, index]));
  return [...items].sort((a, b) => {
    const aOrder = order.get(`${a.countryCode}:${a.isoCountryCode}`) ?? 999;
    const bOrder = order.get(`${b.countryCode}:${b.isoCountryCode}`) ?? 999;
    return aOrder - bOrder || a.label.localeCompare(b.label);
  });
}

async function enrichPreviewWithLivePrices(
  session: DirectSession,
  account: { dtUserId: string; token: string; deviceId?: string | null },
  preview: DingtonePhonePurchasePreview,
  requestConfig: PrivatePhoneRequestConfig
): Promise<DingtonePhonePurchasePreview> {
  const priceCache = new Map<string, Record<string, unknown> | null>();
  const candidates: DingtonePhonePurchaseCandidate[] = [];

  for (const candidate of preview.candidates) {
    const config = resolvePrivatePhoneRequestConfig(candidate.countryCode ?? requestConfig.countryCode, candidate.isoCountryCode ?? requestConfig.isoCountryCode);
    const key = [
      config.countryCode,
      config.isoCountryCode,
      candidate.providerId ?? config.providerIdList[0] ?? "",
      candidate.packageServiceId ?? config.packageServiceId ?? "",
      candidate.category ?? 0,
      candidate.phoneType ?? 2
    ].join(":");

    let quote = priceCache.get(key);
    if (!priceCache.has(key)) {
      quote = await getPhoneNumberPrice(session, account, candidate, config).catch((error) => {
        logger.warn("Direct getNumberPrice failed for candidate", {
          countryCode: config.countryCode,
          isoCountryCode: config.isoCountryCode,
          phoneNumber: candidate.phoneNumber,
          error: error instanceof Error ? error.message : String(error)
        });
        return null;
      });
      priceCache.set(key, quote);
    }

    candidates.push(
      quote ? mergeCandidatePriceQuote(candidate, quote, config) : mergeCandidateFallbackPrice(candidate, config)
    );
  }

  return {
    ...preview,
    candidates
  };
}

async function getPhoneNumberPrice(
  session: DirectSession,
  account: { dtUserId: string; token: string; deviceId?: string | null },
  candidate: DingtonePhonePurchaseCandidate,
  requestConfig: PrivatePhoneRequestConfig
) {
  const countryCode = candidate.countryCode ?? requestConfig.countryCode;
  const providerId = candidate.providerId ?? Number(requestConfig.providerIdList[0] ?? 2000);
  const packageServiceId = candidate.packageServiceId ?? requestConfig.packageServiceId ?? resolvePackageServiceId(countryCode, providerId);
  const bids = ["me.talktone.im", "me.dingtone.im", "me.talkyou.app.im"];
  let lastQuote: Record<string, unknown> | null = null;

  const v2Query = buildGetNumberPriceV2Query(account, candidate, requestConfig, "me.talktone.im");
  lastQuote = await session.callCommonRestJson("getNumberPrice@v2", "/pstn/v2/getNumberPrice", v2Query).catch((error) => {
    logger.warn("Direct getNumberPrice v2 query failed", {
      countryCode,
      isoCountryCode: requestConfig.isoCountryCode,
      error: error instanceof Error ? error.message : String(error)
    });
    return lastQuote;
  });
  if (lastQuote && extractPhonePriceFromQuote(lastQuote) !== undefined) {
    return lastQuote;
  }

  const nativeQuery = buildGetNumberPriceQuery(account, candidate, requestConfig, {
    packageServiceId,
    includeAppContext: false,
    bid: "me.dingtone.im",
    leadingAmpersand: true
  });
  lastQuote = await session.callCommonRestJson("getNumberPrice@native", "/pstn/getNumberPrice", nativeQuery).catch((error) => {
    logger.warn("Direct getNumberPrice native-shaped query failed", {
      countryCode,
      isoCountryCode: requestConfig.isoCountryCode,
      error: error instanceof Error ? error.message : String(error)
    });
    return lastQuote;
  });
  if (lastQuote && extractPhonePriceFromQuote(lastQuote) !== undefined) {
    return lastQuote;
  }

  for (const bid of bids) {
    const query = buildGetNumberPriceQuery(account, candidate, requestConfig, {
      packageServiceId,
      includeAppContext: true,
      bid,
      leadingAmpersand: false
    });

    const quote = await session.callCommonRestJson("getNumberPrice", "/pstn/getNumberPrice", query);
    lastQuote = quote;
    if (extractPhonePriceFromQuote(quote) !== undefined) {
      return quote;
    }
  }

  const appQuery = buildGetNumberPriceQuery(account, candidate, requestConfig, {
    packageServiceId,
    includeAppContext: false,
    bid: "me.dingtone.im",
    leadingAmpersand: false
  });
  lastQuote = await session.callCommonRestJson("getNumberPrice@app", "/pstn/getNumberPrice", appQuery).catch((error) => {
    logger.warn("Direct getNumberPrice app-shaped query failed after compatibility parameters", {
      countryCode,
      isoCountryCode: requestConfig.isoCountryCode,
      error: error instanceof Error ? error.message : String(error)
    });
    return lastQuote;
  });
  if (lastQuote && extractPhonePriceFromQuote(lastQuote) !== undefined) {
    return lastQuote;
  }

  return lastQuote ?? session.callCommonRestJson(
    "getNumberPrice",
    "/pstn/getNumberPrice",
    buildGetNumberPriceQuery(account, candidate, requestConfig, {
      packageServiceId,
      includeAppContext: true,
      bid: "me.dingtone.im",
      leadingAmpersand: false
    })
  );
}

function buildGetNumberPriceQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  candidate: DingtonePhonePurchaseCandidate,
  requestConfig: PrivatePhoneRequestConfig,
  options: { packageServiceId: string; includeAppContext: boolean; bid: string; leadingAmpersand?: boolean }
) {
  const countryCode = candidate.countryCode ?? requestConfig.countryCode;
  const query = [
    queryPair("countryCode", countryCode),
    queryPair("areaCode", candidate.areaCode ?? guessAreaCode(candidate.phoneNumber, countryCode)),
    queryPair("phoneNumber", stripPhonePrefix(candidate.phoneNumber)),
    queryPair("payFlag", 2),
    queryPair("specialNumber", candidate.category ?? 0),
    queryPair("packageServiceId", options.packageServiceId),
    queryPair("storeType", 2),
    queryPair("bid", options.bid)
  ];
  if (options.includeAppContext) {
    query.unshift(
      queryPair("token", account.token),
      queryPair("deviceId", accountDeviceId(account)),
      queryPair("userId", account.dtUserId)
    );
  }
  const joined = query.join("&");
  return options.leadingAmpersand ? `&${joined}` : joined;
}

function buildGetNumberPriceV2Query(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  candidate: DingtonePhonePurchaseCandidate,
  requestConfig: PrivatePhoneRequestConfig,
  bid: string
) {
  const countryCode = candidate.countryCode ?? requestConfig.countryCode;
  return [
    queryPair("token", account.token),
    queryPair("deviceId", accountDeviceId(account)),
    queryPair("userId", account.dtUserId),
    queryPair("phoneNumber", stripPhonePrefix(candidate.phoneNumber)),
    queryPair("countryCode", countryCode),
    queryPair("areaCode", candidate.areaCode ?? guessAreaCode(candidate.phoneNumber, countryCode)),
    queryPair("specialNumber", candidate.category ?? 0),
    queryPair("bid", bid),
    queryPair("multipleProducts", 1),
    queryPair("configVersion", 2)
  ].join("&");
}

function mergeCandidatePriceQuote(
  candidate: DingtonePhonePurchaseCandidate,
  quote: Record<string, unknown>,
  requestConfig: PrivatePhoneRequestConfig
) {
  const price = extractPhonePriceFromQuote(quote) ?? candidate.price;
  const productId = extractPhoneProductIdFromQuote(quote) ?? candidate.productId;
  if (price === undefined) {
    return mergeCandidateFallbackPrice(candidate, requestConfig);
  }
  const raw = parseJsonRecord(candidate.rawJson);
  return {
    ...candidate,
    price,
    productId,
    rawJson: safeJsonStringify({
      ...(raw ?? {}),
      priceQuote: quote,
      ...flattenPriceQuote(quote)
    })
  };
}

function mergeCandidateFallbackPrice(
  candidate: DingtonePhonePurchaseCandidate,
  requestConfig: PrivatePhoneRequestConfig
): DingtonePhonePurchaseCandidate {
  if (candidate.price !== undefined) {
    return candidate;
  }
  const fallback = resolveAppDefaultOrderPrice(candidate, requestConfig);
  if (fallback === undefined) {
    return candidate;
  }
  const raw = parseJsonRecord(candidate.rawJson);
  return {
    ...candidate,
    price: fallback.price,
    rawJson: safeJsonStringify({
      ...(raw ?? {}),
      price: fallback.price,
      priceType: fallback.priceType,
      extraChargeMonthsCount: fallback.extraChargeMonthsCount,
      extraChargeMonthsPrice: fallback.extraChargeMonthsPrice,
      priceSource: "apk-default",
      priceNote: "Fallback from TalkU APK PrivatePhoneOrderPriceManager defaults when live getNumberPrice is unavailable."
    })
  };
}

function resolveAppDefaultOrderPrice(candidate: DingtonePhonePurchaseCandidate, requestConfig: PrivatePhoneRequestConfig) {
  const applyType = requestConfig.applyType ?? candidate.category;
  const priceType = mapApplyTypeToPriceType(applyType, requestConfig.countryCode, candidate.phoneType);
  const price = APP_DEFAULT_ORDER_PRICES_BY_PRICE_TYPE[priceType];
  return price === undefined
    ? undefined
    : {
        price,
        priceType,
        extraChargeMonthsCount: APP_DEFAULT_EXTRA_CHARGE_MONTHS_COUNT_BY_PRICE_TYPE[priceType] ?? 12,
        extraChargeMonthsPrice: APP_DEFAULT_EXTRA_CHARGE_MONTHS_PRICE_BY_PRICE_TYPE[priceType]
      };
}

function mapApplyTypeToPriceType(applyType: number | undefined, countryCode: number, phoneType: number | undefined) {
  if (countryCode === 1 && phoneType === 3) {
    return 4;
  }
  if (countryCode === 1 && phoneType === 5) {
    return 2;
  }
  if (countryCode === 1 && phoneType === 6) {
    return 3;
  }
  const mapping: Record<number, number> = {
    1: 1,
    2: 5,
    3: 12,
    5: 11,
    6: 8,
    7: 9,
    9: 10,
    11: 14,
    13: 16,
    14: 17,
    15: 18,
    16: 19,
    17: 20,
    18: 21,
    19: 22,
    20: 23,
    21: 24,
    22: 25,
    23: 26,
    24: 27
  };
  return applyType !== undefined ? (mapping[applyType] ?? 1) : 1;
}

const APP_DEFAULT_ORDER_PRICES_BY_PRICE_TYPE: Record<number, number> = {
  1: 100,
  2: 250,
  3: 750,
  4: 10,
  5: 50,
  8: 50,
  9: 50,
  10: 50,
  11: 50,
  12: 60,
  14: 50,
  16: 450,
  17: 400,
  18: 250,
  19: 250,
  20: 250,
  21: 250,
  22: 400,
  23: 400,
  24: 400,
  25: 550,
  26: 1000,
  27: 1000
};

const APP_DEFAULT_EXTRA_CHARGE_MONTHS_COUNT_BY_PRICE_TYPE: Record<number, number> = {
  4: 0
};

const APP_DEFAULT_EXTRA_CHARGE_MONTHS_PRICE_BY_PRICE_TYPE: Record<number, number> = {
  1: 1000,
  2: 2500,
  3: 7500,
  4: 100,
  5: 500,
  6: 600,
  8: 500,
  9: 500,
  10: 1000,
  11: 1000,
  12: 600,
  13: 100,
  14: 500,
  16: 4500,
  17: 4000,
  18: 2500,
  19: 2500,
  20: 2500,
  21: 2500,
  22: 4000,
  23: 4000,
  24: 4000,
  25: 5500,
  26: 10000,
  27: 10000
};

function extractPhonePriceFromQuote(value: unknown) {
  const records = collectNestedRecords(value);
  return (
    pickNumberFromRecords(records, [
      "price",
      "orderPrice",
      "order_price",
      "payAmount",
      "pay_amount",
      "needPay",
      "need_pay",
      "needBalance",
      "need_balance",
      "creditPrice",
      "credit_price",
      "credit",
      "creditNum",
      "credit_num",
      "amount",
      "totalPrice",
      "total_price"
    ]) ?? null
  );
}

function extractPhoneProductIdFromQuote(value: unknown) {
  return pickStringFromRecords(collectNestedRecords(value), ["productId", "product_id"]) ?? null;
}

function flattenPriceQuote(value: unknown) {
  const record = collectNestedRecords(value)[0] ?? {};
  return {
    monthDollarPrice: pickNumber(record, ["monthDollarPrice", "month_dollar_price"]),
    yearDollarPrice: pickNumber(record, ["yearDollarPrice", "year_dollar_price"]),
    extraChargeMonthsCount: pickNumber(record, ["extraChargeMonthsCount", "extra_charge_months_count"]),
    extraChargeMonthsPrice: pickNumber(record, ["extraChargeMonthsPrice", "extra_charge_months_price"])
  };
}

function normalizePhonePurchasePreview(value: unknown): DingtonePhonePurchasePreview {
  const priceHints = buildPhonePriceHints(value);
  const candidates = extractPhoneCandidates(value)
    .map((item) => enrichPhonePurchaseCandidate(normalizePhonePurchaseCandidate(item), priceHints))
    .filter((item) => Boolean(item.phoneNumber));
  return {
    freeChance: pickNumberFromRecords(collectNestedRecords(value), ["freeChance", "free_chance"]),
    candidates,
    rawJson: safeJsonStringify(value)
  };
}

function enrichPhonePurchaseCandidate(
  candidate: DingtonePhonePurchaseCandidate,
  priceHints: Map<string, number>
): DingtonePhonePurchaseCandidate {
  if (candidate.price !== undefined) {
    return candidate;
  }
  const price = pickPhonePriceHint(candidate, priceHints);
  return price === undefined ? candidate : { ...candidate, price };
}

function buildPhonePriceHints(value: unknown) {
  const hints = new Map<string, number>();
  for (const record of collectNestedRecords(value)) {
    const price = pickNumber(record, [
      "orderPrice",
      "order_price",
      "price",
      "reserved5",
      "payAmount",
      "pay_amount",
      "amount",
      "coinCost",
      "coin_cost",
      "needPay",
      "need_pay",
      "needBalance",
      "need_balance",
      "cost",
      "totalPrice",
      "total_price"
    ]);
    if (price === undefined) {
      continue;
    }
    if (!pickString(record, ["phoneNumber", "phone_number", "number", "privateNumber", "private_number"]) && !pickString(record, ["packageServiceId", "package_service_id"])) {
      continue;
    }
    for (const key of phonePriceHintKeys(normalizePhonePurchaseCandidate(record))) {
      hints.set(key, price);
    }
  }
  return hints;
}

function pickPhonePriceHint(candidate: DingtonePhonePurchaseCandidate, hints: Map<string, number>) {
  for (const key of phonePriceHintKeys(candidate)) {
    const price = hints.get(key);
    if (price !== undefined) {
      return price;
    }
  }
  return undefined;
}

function phonePriceHintKeys(candidate: DingtonePhonePurchaseCandidate) {
  const keys: string[] = [];
  const country = candidate.countryCode;
  const provider = candidate.providerId;
  const pkg = candidate.packageServiceId;
  const type = candidate.phoneType;
  const category = candidate.category;
  if (country !== undefined && provider !== undefined && pkg) {
    keys.push(`country:${country}:provider:${provider}:package:${pkg}`);
  }
  if (country !== undefined && pkg) {
    keys.push(`country:${country}:package:${pkg}`);
  }
  if (provider !== undefined && pkg) {
    keys.push(`provider:${provider}:package:${pkg}`);
  }
  if (pkg) {
    keys.push(`package:${pkg}`);
  }
  if (country !== undefined && provider !== undefined && type !== undefined && category !== undefined) {
    keys.push(`country:${country}:provider:${provider}:type:${type}:category:${category}`);
  }
  if (country !== undefined && provider !== undefined) {
    keys.push(`country:${country}:provider:${provider}`);
  }
  if (country !== undefined) {
    keys.push(`country:${country}`);
  }
  return keys;
}

function normalizePhonePurchaseCandidate(value: unknown): DingtonePhonePurchaseCandidate {
  const record = isRecord(value) ? value : {};
  return {
    phoneNumber: pickString(record, ["phoneNumber", "phone_number", "number", "privateNumber", "private_number"]) ?? "",
    countryCode: pickNumber(record, ["countryCode", "country_code"]),
    areaCode: pickNumber(record, ["areaCode", "area_code"]),
    providerId: pickNumber(record, ["providerId", "provider_id"]),
    packageServiceId: pickString(record, ["packageServiceId", "package_service_id"]),
    category: pickNumber(record, ["category", "purchaseType", "purchase_type"]),
    phoneType: pickNumber(record, ["phoneType", "phone_type", "payType", "pay_type"]),
    displayName: pickString(record, ["displayName", "display_name", "cityName", "city_name", "stateName", "state_name"]),
    cityName: pickString(record, ["cityName", "city_name"]),
    stateName: pickString(record, ["stateName", "state_name"]),
    isoCountryCode: pickString(record, ["isoCountryCode", "iso_country_code", "isoCC", "iso_cc"]),
    goodNumberLevel: pickNumber(record, ["goodNumberLevel", "good_number_level"]),
    useHistory: pickNumber(record, ["useHistory", "use_history"]),
    productId: pickString(record, ["productId", "product_id"]),
    price: pickNumber(record, [
      "orderPrice",
      "order_price",
      "price",
      "creditPrice",
      "credit_price",
      "reserved5",
      "payAmount",
      "pay_amount",
      "amount",
      "credit",
      "creditNum",
      "credit_num",
      "coinCost",
      "coin_cost",
      "needPay",
      "need_pay",
      "needBalance",
      "need_balance",
      "cost",
      "totalPrice",
      "total_price"
    ]),
    rawJson: safeJsonStringify(value)
  };
}

function extractPhoneCandidates(value: unknown) {
  const records = collectNestedRecords(value);
  for (const record of records) {
    const list =
      (Array.isArray(record.candidates) && record.candidates) ||
      (Array.isArray(record.phones) && record.phones) ||
      (Array.isArray(record.phoneNumbers) && record.phoneNumbers) ||
      (Array.isArray(record.phoneList) && record.phoneList) ||
      (Array.isArray(record.numberExList) && record.numberExList) ||
      (Array.isArray(record.numberList) && record.numberList) ||
      (Array.isArray(record.phone_numbers) && record.phone_numbers) ||
      (Array.isArray(record.items) && record.items) ||
      (Array.isArray(record.list) && record.list);
    if (list && list.length > 0) {
      return list;
    }
  }
  return [];
}

function extractOrderedPhone(value: unknown) {
  const records = collectNestedRecords(value);
  for (const record of records) {
    if (isRecord(record.orderPayload)) {
      return record.orderPayload;
    }
    if (isRecord(record.phone)) {
      return record.phone;
    }
    if (isRecord(record.privateNumber)) {
      return record.privateNumber;
    }
  }
  return extractPhoneCandidates(value)[0];
}

function assertDirectApiSuccess(value: unknown, action: string) {
  if (!isRecord(value)) {
    return;
  }
  const result = value.Result ?? value.result;
  const errCode = value.ErrCode ?? value.errCode ?? value.errorCode ?? value.code;
  const status = value.status ?? value.Status;
  const success = value.success ?? value.ok;
  const message = stringifyPrimitive(value.Reason ?? value.reason ?? value.message ?? value.error ?? value.resultMsg ?? value.result_msg);

  if (result === "socket_closed_after_write" || result === "no_response_after_write") {
    return;
  }
  if (action === "purchasePhone" && isUnconfirmedPurchaseError(message, errCode, result, status)) {
    return;
  }
  if (success === false || result === 0 || result === "0" || status === "error") {
    throw new AppError(
      `Direct ${action} failed: ${message ? redactSensitiveText(message) : `server returned ${String(errCode ?? result ?? status)}`}`,
      502,
      502
    );
  }
  if (errCode !== undefined && Number(errCode) !== 0) {
    throw new AppError(
      `Direct ${action} failed: ${message ? redactSensitiveText(message) : `server returned ${String(errCode)}`}`,
      502,
      502
    );
  }
}

function isUnconfirmedPurchaseError(message: string | null | undefined, errCode: unknown, result: unknown, status: unknown) {
  const text = [message, errCode, result, status].map((item) => String(item ?? "")).join(" ");
  return /rest call failed|jsonobject text must begin|jsontokener|responsejson/i.test(text);
}

function isUnconfirmedPhoneActionResult(value: unknown) {
  if (!isRecord(value)) {
    return false;
  }
  const result = value.Result ?? value.result;
  return result === "socket_closed_after_write" || result === "no_response_after_write";
}

function normalizePhoneNumbers(value: unknown): DingtonePhoneNumber[] {
  const records = collectRecords(value);
  const list = firstArray(records, [
    "numberExList",
    "numberExlist",
    "numberList",
    "number_list",
    "phoneNumbers",
    "phone_numbers",
    "items",
    "list"
  ]);

  return (list ?? [])
    .map((item) => normalizePhoneNumber(item))
    .filter((item) => Boolean(item.phoneNumber));
}

function normalizePhoneNumber(value: unknown): DingtonePhoneNumber {
  const record = isRecord(value) ? value : {};
  return {
    phoneNumber: pickString(record, ["phoneNumber", "phone_number", "number"]) ?? "",
    countryCode: pickNumber(record, ["countryCode", "country_code"]),
    providerId: pickNumber(record, ["providerId", "provider_id"]),
    displayName: pickString(record, ["displayName", "display_name"]) ?? undefined,
    status: normalizePhoneStatus(record),
    purchaseType: pickNumber(record, ["purchaseType", "purchase_type"]),
    payType: pickNumber(record, ["payType", "pay_type"]),
    validPeriodDays: pickNumber(record, ["validPeriodDays", "valid_period_days", "usePeriod", "use_period"]),
    gainTime: stringifyPrimitive(record.gainTime ?? record.gain_time),
    expiredTime: stringifyPrimitive(record.expireTime ?? record.expire_time),
    autoRenew: pickBoolean(record, ["autoRenew", "auto_renew"]),
    isPrimary: pickBoolean(record, ["isPrimary", "is_primary", "primaryFlag", "primary_flag"]),
    isGoodNumber: pickBoolean(record, ["isGoodNumber", "is_good_number"]),
    portoutInfo: pickString(record, ["portoutInfo", "portout_info"]),
    rawJson: safeJsonStringify(value)
  };
}

function normalizePhoneNumberPatch(value: unknown): Partial<DingtonePhoneNumber> {
  const normalized = normalizePhoneNumber(value);
  return {
    countryCode: normalized.countryCode,
    providerId: normalized.providerId,
    displayName: normalized.displayName,
    status: normalized.status,
    purchaseType: normalized.purchaseType,
    payType: normalized.payType,
    validPeriodDays: normalized.validPeriodDays,
    gainTime: normalized.gainTime,
    expiredTime: normalized.expiredTime,
    autoRenew: normalized.autoRenew,
    isPrimary: normalized.isPrimary,
    isGoodNumber: normalized.isGoodNumber,
    portoutInfo: normalized.portoutInfo,
    rawJson: normalized.rawJson
  };
}

function normalizePhoneStatus(record: Record<string, unknown>): DingtonePhoneNumber["status"] {
  const explicit = pickString(record, ["status", "phoneStatus", "phone_status"])?.toLowerCase();
  if (explicit === "active" || explicit === "paused" || explicit === "expired" || explicit === "cancelled" || explicit === "pending") {
    return explicit;
  }
  if (pickBoolean(record, ["cancelled", "isCancelled", "is_cancelled"])) {
    return "cancelled";
  }
  if (pickBoolean(record, ["suspendFlag", "suspend_flag", "paused", "isPaused", "is_paused"])) {
    return "paused";
  }
  const expireTime = pickNumber(record, ["expireTime", "expire_time"]);
  if (expireTime && expireTime <= Date.now()) {
    return "expired";
  }
  return "active";
}

function buildSnapshot(input: {
  account: { dtUserId: string; token: string; email?: string | null; phone?: string | null };
  balance: ApiResult;
  userSetting: ApiResult;
  profile: ApiResult;
}): DingtoneSnapshot {
  const balance = collectRecords(input.balance);
  const settings = collectRecords(input.userSetting);
  const profile = collectRecords(input.profile);
  const primaryBalance = pickNumberFromRecords(balance, ["primaryBalance", "balance", "primary_balance"]);
  const raw = {
    balance: input.balance,
    userSetting: input.userSetting,
    profile: input.profile
  };
  return {
    dtDingtoneId: pickStringFromRecords(profile, ["dingtoneId", "dtDingtoneId", "userId"]),
    fullName: pickStringFromRecords(profile, ["fullName", "full_name", "nickname", "name"]),
    avatarUrl: pickStringFromRecords(profile, ["avatarUrl", "avatar_url", "photoUrl"]),
    gender: pickNumberFromRecords(profile, ["gender", "sex"]),
    birthday: pickStringFromRecords(profile, ["birthday", "birthDay"]),
    email: input.account.email ?? pickStringFromRecords(profile, ["email"]),
    phone: input.account.phone ?? pickStringFromRecords(profile, ["phone", "phoneNumber", "phone_number"]),
    aboutMe: pickStringFromRecords(profile, ["aboutMe", "about_me", "signature"]),
    feeling: pickStringFromRecords(profile, ["feeling", "mood"]),
    company: pickStringFromRecords(profile, ["company"]),
    school: pickStringFromRecords(profile, ["school"]),
    country: pickStringFromRecords(profile, ["country", "countryName"]),
    state: pickStringFromRecords(profile, ["state", "province"]),
    city: pickStringFromRecords(profile, ["city"]),
    primaryBalance,
    userGrade: pickNumberFromRecords(balance, ["userGrade", "user_grade", "grade"]),
    validPoint: pickNumberFromRecords(balance, ["validPoint", "valid_point", "progressPoint"]),
    progressPoint: pickNumberFromRecords(balance, ["progressPoint", "progress_point"]),
    progressPointTotal: pickNumberFromRecords(balance, [
      "progressPointTotal",
      "progress_point_total",
      "totalProgressPoint",
      "total_progress_point",
      "progressTotalPoint",
      "progress_total_point",
      "pointTotal",
      "point_total",
    ]),
    membershipType: pickStringFromRecords(settings, ["membershipType", "membership_type"]),
    membershipLevelLabel: pickStringFromRecords(settings, [
      "membershipLevelLabel",
      "membership_level_label",
      "levelName",
      "level_name",
      "vipLevelName",
      "vip_level_name",
      "gradeName",
      "grade_name",
    ]),
    membershipExpireAt: pickDateFromRecords(settings, ["membershipExpireAt", "membership_expire_at"]),
    profileVerCode: pickStringFromRecords(settings, ["userSettingVerId", "profileVerCode", "profile_ver_code"]),
    rawJson: safeJsonStringify(raw)
  };
}

function collectRecords(value: unknown) {
  const records: Record<string, unknown>[] = [];
  const push = (candidate: unknown) => {
    if (isRecord(candidate)) {
      records.push(candidate);
    }
  };

  push(value);
  if (isRecord(value)) {
    push(value.data);
    push(value.result);
    push(value.profile);
    push(value.balance);
    push(value.snapshot);
    push(value.userSetting);
    push(value.userProperties);
    push(value.userProperty);
    push(value.content);
    push(value.numberExList);
    push(value.numberList);
  }
  return records;
}

function collectNestedRecords(value: unknown) {
  const records: Record<string, unknown>[] = [];
  const visited = new Set<unknown>();
  const visit = (candidate: unknown, depth = 0) => {
    if (depth > 5 || candidate === null || candidate === undefined || visited.has(candidate)) {
      return;
    }
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, depth + 1);
      }
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    records.push(candidate);
    for (const child of Object.values(candidate)) {
      visit(child, depth + 1);
    }
  };

  visit(value);
  return records;
}

function firstArray(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return undefined;
}

function pickStringFromRecords(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    const value = pickString(record, keys);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function pickNumberFromRecords(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    const value = pickNumber(record, keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pickDateFromRecords(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    const value = pickDate(record, keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const normalized = normalizePickedString(value);
      if (normalized) {
        return normalized;
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function normalizePickedString(value: string) {
  const normalized = value.trim();
  return isNullishStringLiteral(normalized) ? "" : normalized;
}

function isNullishStringLiteral(value: string) {
  return /^(null|undefined|none|nil)$/i.test(value);
}

function pickBoolean(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (value === 1) {
        return true;
      }
      if (value === 0 || value === -1) {
        return false;
      }
      return undefined;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "0" || normalized === "-1") {
        return false;
      }
    }
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickDate(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return new Date(value > 1_000_000_000_000 ? value : value * 1000);
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return new Date(parsed > 1_000_000_000_000 ? parsed : parsed * 1000);
      }
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }
  return undefined;
}

function stringifyPrimitive(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializeError: true });
  }
}

function redactSensitiveText(value: string) {
  return value
    .replace(/token=[^,\s)]+/gi, "token=<redacted>")
    .replace(/\b[0-9a-f]{32}\b/gi, "<redacted>");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountDeviceId(account: { dtUserId: string; deviceId?: string | null }) {
  const existing = account.deviceId;
  if (existing && existing.trim()) {
    return existing.trim();
  }
  return `Android.${hashLike(account.dtUserId)}.dttalk`;
}

function resolveDirectAccountAppId(deviceId: string) {
  return isTalkUDeviceId(deviceId) ? TALKU_APP_ID : DINGTONE_APP_ID;
}

function resolveDirectAccountApkCertificateSign(deviceId: string, fallback: string) {
  return isTalkUDeviceId(deviceId) ? TALKU_APK_CERTIFICATE_SIGN : fallback;
}

function resolveDirectApiApkCertificateSign(deviceId: string, fallback: string) {
  return isTalkUDeviceId(deviceId) ? TALKU_DIRECT_API_CERTIFICATE_SIGN : fallback;
}

function isTalkUDeviceId(deviceId: string) {
  const normalized = deviceId.trim().toLowerCase();
  return normalized.endsWith(".dttalk") || normalized.includes("dttalk");
}

function directSessionAccountKey(account: { dtUserId: string; deviceId?: string | null }) {
  return account.dtUserId;
}

function preemptActiveDirectPushListener(account: { dtUserId: string; deviceId?: string | null }) {
  const active = activeDirectPushListeners.get(directSessionAccountKey(account));
  if (!active || active.preempted) {
    return false;
  }
  active.preempted = true;
  void active.session?.close().catch(() => undefined);
  for (const session of active.sessions ?? []) {
    void session.close().catch(() => undefined);
  }
  return true;
}

async function runWithDirectSessionOperationLock<T>(account: { dtUserId: string; deviceId?: string | null }, task: () => Promise<T>) {
  const key = directSessionAccountKey(account);
  const previous = directSessionOperationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  directSessionOperationLocks.set(key, current);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (directSessionOperationLocks.get(key) === current) {
      directSessionOperationLocks.delete(key);
    }
  }
}

async function waitForDirectSessionOperationIdle(account: { dtUserId: string; deviceId?: string | null }) {
  await directSessionOperationLocks.get(directSessionAccountKey(account))?.catch(() => undefined);
}

function hashLike(input: string) {
  let seed = 0;
  for (const char of input) {
    seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `${seed.toString(16).padStart(8, "0")}${seed.toString(16).padStart(8, "0")}${seed.toString(16).padStart(8, "0")}${seed
    .toString(16)
    .padStart(8, "0")}`.slice(0, 32);
}

function createDirectTrackCode(seed: string) {
  const base = BigInt("40051185300000000");
  let acc = 0n;
  for (const char of seed) {
    acc = (acc * 31n + BigInt(char.charCodeAt(0))) % 900000n;
  }
  return (base + 100000n + acc).toString();
}

function createDirectTrackCodeGenerator(seed: string) {
  let current = BigInt(createDirectTrackCode(seed));
  return () => {
    const value = current;
    current += 1n;
    return value.toString();
  };
}

async function getDirectRuntimeConfig(): Promise<DirectRuntimeConfig> {
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  return {
    primaryHost: settings.dt_server_ip || config.DT_SERVER_IP,
    backupHost: settings.dt_backup_ip || config.DT_BACKUP_IP,
    port: Number(settings.dt_server_port || config.DT_SERVER_PORT) || config.DT_SERVER_PORT,
    connectTimeoutMs: 10_000,
    ioTimeoutMs: 15_000,
    useTls: parseBooleanSetting(settings.dt_direct_use_tls, config.DT_DIRECT_USE_TLS),
    appVersion: config.DT_APP_VERSION,
    apkCertificateSign: config.DT_APK_CERTIFICATE_SIGN,
    listenHostConcurrency: parsePositiveIntSetting(settings.dt_direct_listener_host_concurrency, 2, 1, 8)
  };
}

async function getConfiguredDirectTemplate(key: DirectTemplateSettingKey): Promise<DirectActionTemplate | null> {
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  return parseDirectActionTemplate(key, settings[key]);
}

function getBuiltInDirectTemplate(key: DirectTemplateSettingKey): DirectActionTemplate | null {
  if (key !== "dt_direct_template_offline_messages") {
    return null;
  }
  return {
    name: "built-in requestAllOfflineMessage",
    hex: TEMPLATES.requestAllOfflineMessage.toString("hex"),
    params: {
      deviceId: "$deviceId",
      userId: "$userId",
      token: "$token"
    }
  };
}

function flattenTemplateObject(value: unknown, prefix: string): DirectTemplateParams {
  if (!isRecord(value)) {
    return {};
  }
  const params: DirectTemplateParams = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      params[`${prefix}.${key}`] = item;
      params[`${prefix}_${key}`] = item;
    }
  }
  return params;
}

function parseBooleanSetting(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parsePositiveIntSetting(value: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function uniqueHosts(hosts: string[]) {
  return Array.from(new Set(hosts.map((value) => value.trim()).filter(Boolean)));
}

function normalizeDirectError(error: unknown) {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof Error) {
    return new AppError(error.message, 502, 502);
  }
  return new AppError("Direct gateway request failed", 502, 502);
}

function isFatalDirectSessionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /authen failed|deviceid not find|60011|missing dt_token|missing dt_user_id|bootstrap failed/i.test(message);
}

function isSocketClosedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /socket.*closed|closed.*socket|econnreset|write after end/i.test(message);
}

function isNoResponseAfterPhoneActionWrite(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    isSocketClosedError(error) ||
    /timed out waiting for .* JSON response/i.test(message) ||
    /jsonobject text must begin|jsontokener|responsejson|rest call failed/i.test(message)
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
