import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "../../config.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { getSettingsMap } from "../settings.service.js";
import { parseDirectActionTemplate, type DirectActionTemplate, type DirectTemplateParams } from "./direct-template.js";
import { isOfflineMessageIndexPush, parseSmsPush, type ParsedSmsPush } from "./message-parser.js";
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
  registerEmailPort: number;
  connectTimeoutMs: number;
  ioTimeoutMs: number;
  useTls: boolean;
  registerEmailUseTls: boolean;
  appVersion: string;
  dingdongAppVersion: string;
  apkCertificateSign: string;
  proxyUrl: string;
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
  appVariant?: "dingtone" | "dingdong";
};
type DirectAccountIdentity = {
  deviceId?: string | null;
  appVariant?: "dingtone" | "dingdong";
};
type DirectActivationIdentity = string | DirectAccountIdentity;
type DirectActivationTemplateSettingKey =
  | "dt_direct_template_check_activated_user"
  | "dt_direct_template_check_activated_user_talku"
  | "dt_direct_template_check_activated_user_dingdong"
  | "dt_direct_template_register_email"
  | "dt_direct_template_register_email_talku"
  | "dt_direct_template_register_email_dingdong"
  | "dt_direct_template_activate_email"
  | "dt_direct_template_activate_email_talku"
  | "dt_direct_template_activate_email_dingdong";
type DirectPhoneTemplateSettingKey =
  | "dt_direct_template_request_phone"
  | "dt_direct_template_purchase_phone"
  | "dt_direct_template_renew_phone"
  | "dt_direct_template_cancel_phone"
  | "dt_direct_template_pause_phone"
  | "dt_direct_template_resume_phone"
  | "dt_direct_template_phone_setting";
type DirectTemplateSettingKey =
  | "dt_direct_template_check_activated_user"
  | "dt_direct_template_check_activated_user_talku"
  | "dt_direct_template_check_activated_user_dingdong"
  | "dt_direct_template_register_email"
  | "dt_direct_template_register_email_talku"
  | "dt_direct_template_register_email_dingdong"
  | "dt_direct_template_activate_email"
  | "dt_direct_template_activate_email_talku"
  | "dt_direct_template_activate_email_dingdong"
  | "dt_direct_template_request_phone"
  | "dt_direct_template_purchase_phone"
  | "dt_direct_template_renew_phone"
  | "dt_direct_template_cancel_phone"
  | "dt_direct_template_pause_phone"
  | "dt_direct_template_resume_phone"
  | "dt_direct_template_phone_setting"
  | "dt_direct_template_offline_messages";

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

export type DirectWebOfflineMessage = {
  conversationType: 4;
  conversationId: string | null;
  type: number | null;
  senderId: string | null;
  msgId: string | null;
  content: string;
  timestamp: number | null;
  isRead: number;
  data1: string | null;
  data2: string | null;
  data3: "direct-web-offline";
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
  offlineTemplateSendCount?: number;
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
export type DirectActivatedUserProbeResult = {
  ok: boolean;
  host: string;
  target: string;
  calls: DirectProbeCallResult[];
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
  | "enableSmsReceive"
  | "updatePhoneLabel"
  | "clearPhoneLabel";

type ActiveDirectPushListener = {
  key: string;
  preempted: boolean;
  session?: DirectSession;
  sessions?: Set<DirectSession>;
  done: Promise<void>;
  resolveDone: () => void;
};

const CONNECT_REQUEST = Buffer.from("01070000000e820100000000c88d", "hex");
const MAX_DIRECT_TRACE_FRAMES = 80;
const APP_DIRECT_PUSH_HOSTS = [
  // These hosts delivered real SMS frames in production monitor sessions.
  "20.97.117.109",
  "206.189.228.89",
  "44.199.32.84",
  "44.198.131.100",
  "157.230.90.253",
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
const DINGTONE_BUSINESS_APP_ID = "me.dingtone.im";
const TALKU_APK_CERTIFICATE_SIGN = "bf6bf7a31a53d5c06dd1c7d03fd3d917";
const TALKU_DIRECT_API_CERTIFICATE_SIGN = "458cf4f3e576f61a26187d218e4af9d3";
const DIRECT_ACTIVATION_CLIENT_VERSION = 1023;
const DIRECT_ACTIVATE_EMAIL_CLIENT_VERSION = -1610218240;
const DIRECT_ACTIVATION_EMAIL_CRYPTO_IV = Buffer.from("5875b9f15ed445239539cb455cdcbed7", "hex");
const DIRECT_REFRESH_ATTEMPT_TIMEOUT_MS = 4_000;
const DIRECT_OFFLINE_CATCHUP_INTERVAL_MS = 30_000;
const DIRECT_OFFLINE_CATCHUP_RETRY_MS = 30_000;
const DIRECT_NOTIFY_ONLY_CATCHUP_THROTTLE_MS = 60_000;
const DIRECT_WEB_OFFLINE_POLL_INTERVAL_MS = 60_000;
const DIRECT_RECONNECT_BACKOFF_MAX_MS = 1_000;
const DIRECT_SESSION_OPERATION_IDLE_WAIT_MS = 5_000;
const DIRECT_PUSH_HOST_CONCURRENCY = 2;
const DIRECT_PUSH_NON_SMS_FRAME_BATCH_LIMIT = 5;
const DIRECT_PUSH_NON_SMS_FRAME_PAUSE_MS = 1_000;
const DIRECT_IDLE_NON_SMS_FRAME_PAUSE_BATCH = 3;
const DIRECT_IDLE_NON_SMS_FRAME_PAUSE_MS = 750;
const DIRECT_SOCKET_FRAME_BUDGET_PER_TICK = 20;
const DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS = 5_000;
const DIRECT_SESSION_KEEPALIVE_INTERVAL_MS = 5_000;
const DINGDONG_SESSION_KEEPALIVE_INTERVAL_MS = 2_000;
const CAPTURED_OFFLINE_FIELDS = {
  deviceId: "And.11111111111111111111111111111111.dttalk"
} as const;
const activeDirectPushListeners = new Map<string, ActiveDirectPushListener>();
const directSessionOperationLocks = new Map<string, Promise<void>>();
const directAccountPhoneCountryKeyCache = new Map<string, Set<string>>();
const directWebOfflineDeliveryTrackers = new Map<string, DirectWebOfflineDeliveryTracker>();
const directSmsHostAffinity = new Map<string, string[]>();
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
  getWebOfflineMessage: Buffer.from(
    "0107000000eb81078656004e000000db0102000000dbe7e9000300508372000000000000000101010000000001000000150000001765372e65392e30302e30332e30302e35302e38332e37320000001730302e30302e30302e30302e30302e30302e30302e3031000000080000007c000000013200000011676574557365724f66666c696e654d73670000009800000056789c4b492dcb4c4ef54cb175cc4bd1332000f4524a4a1273b2d54a8b538b3c536c0d5165d54af2b353f36c0919a2165294989ced9c9f926a6b6260606a6868616a6c60686469686068a896e402768fad21006f6125e500000000",
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
  { countryKey: "US", label: "缂傚洤楠稿ù?+1", countryCode: 1, isoCountryCode: "US", providerIdList: ["2000", "2001"], packageServiceId: "DT01001", applyType: 1, randomAreaCodes: [213, 646, 312, 415, 305, 212, 323, 424, 469, 512, 628, 702, 786, 929, 971] },
  { countryKey: "CA", label: "闁告梻濮电€ｄ焦寰?+1", countryCode: 1, isoCountryCode: "CA", providerIdList: ["2000", "2001"], packageServiceId: "DT02002", applyType: 2, randomAreaCodes: [416, 647, 437, 604, 778, 236, 514, 438, 613, 343] },
  { countryKey: "GB", label: "闁艰宕ù?+44", countryCode: 44, isoCountryCode: "GB", providerIdList: ["2001", "2007"], packageServiceId: "DT02001", applyType: 3 },
  { countryKey: "BE", label: "婵絾鏌ㄩ崺鍕籍?+32", countryCode: 32, isoCountryCode: "BE", providerIdList: ["2002"], packageServiceId: "DT03001", applyType: 5 },
  { countryKey: "NL", label: "闁艰棄鍢查崣?+31", countryCode: 31, isoCountryCode: "NL", providerIdList: ["2006"], packageServiceId: "DT03005", applyType: 9 },
  { countryKey: "RU", label: "濞ｅ洤瀚紞蹇涘棘?+7", countryCode: 7, isoCountryCode: "RU", providerIdList: ["2003"], packageServiceId: "DT03002", applyType: 6 },
  { countryKey: "ES", label: "閻熸娉曡ぐ顕€鎮?+34", countryCode: 34, isoCountryCode: "ES", providerIdList: ["2004"], packageServiceId: "DT03003", applyType: 7 },
  { countryKey: "CN", label: "濞戞搩鍘煎ù?+86", countryCode: 86, isoCountryCode: "CN", providerIdList: ["2030"], packageServiceId: "DT04001", applyType: 11 },
  { countryKey: "AU", label: "婵犮垹鍟块妵鍥礆閳衡偓缁?+61", countryCode: 61, isoCountryCode: "AU", providerIdList: ["2008"], packageServiceId: "DT03007", applyType: 13 },
  { countryKey: "AT", label: "濠靛倶鍎卞﹢鎾礆?+43", countryCode: 43, isoCountryCode: "AT", providerIdList: ["2100"], packageServiceId: "DT03008", applyType: 14 },
  { countryKey: "FR", label: "婵炲娲栧ù?+33", countryCode: 33, isoCountryCode: "FR", providerIdList: ["2100"], packageServiceId: "DT03009", applyType: 15 },
  { countryKey: "SE", label: "闁荤喓鍋涢崥鈧?+46", countryCode: 46, isoCountryCode: "SE", providerIdList: ["2100"], packageServiceId: "DT03010", applyType: 16 },
  { countryKey: "MU", label: "婵絾鐩崳宄靶ч崒娑欑効 +230", countryCode: 230, isoCountryCode: "MU", providerIdList: ["2100"], packageServiceId: "DT03011", applyType: 17 },
  { countryKey: "PL", label: "婵炲鍨归崣?+48", countryCode: 48, isoCountryCode: "PL", providerIdList: ["2300"], packageServiceId: "DT05003", applyType: 18 },
  { countryKey: "ID", label: "闁告婢樼€瑰磭浜搁懝鑸仾濞?+62", countryCode: 62, isoCountryCode: "ID", providerIdList: ["2300"], packageServiceId: "DT05004", applyType: 19 },
  { countryKey: "PR", label: "婵炲鍨归ˇ鎸庮渶鎼粹剝鍊?+1787", countryCode: 1787, isoCountryCode: "PR", providerIdList: ["2300"], packageServiceId: "DT05005", applyType: 20 },
  { countryKey: "CZ", label: "闁圭懓鍢查崢?+420", countryCode: 420, isoCountryCode: "CZ", providerIdList: ["2300"], packageServiceId: "DT05006", applyType: 21 },
  { countryKey: "MY", label: "濡炶鍓氬鐢垫啿婢跺摜鑲?+60", countryCode: 60, isoCountryCode: "MY", providerIdList: ["2300"], packageServiceId: "DT05007", applyType: 22 },
  { countryKey: "DK", label: "濞戞挸缍婄€?+45", countryCode: 45, isoCountryCode: "DK", providerIdList: ["2300"], packageServiceId: "DT05008", applyType: 23 },
  { countryKey: "RO", label: "缂傚啯顨婇埞鍫焊闂傚鑲?+40", countryCode: 40, isoCountryCode: "RO", providerIdList: ["2300"], packageServiceId: "DT05009", applyType: 24 }
];

export class DirectDingtoneGateway implements DingtoneGateway {
  async sendVerificationCode(input: DingtoneLoginInput): Promise<VerificationRequestResult> {
    if (input.loginType !== "email_code") {
      throw new AppError("Direct verification login currently supports email_code only.", 501, 501);
    }
    const email = normalizeEmailLoginTarget(input.email);
    const runtime = await getDirectRuntimeConfig();

    let activatedUser: any = null;
    try {
      const rawPayload = await callDirectActivationApi(
        runtime,
        { appVariant: input.appVariant, deviceId: input.deviceId },
        "checkActivatedUser",
        "checkActivatedUser",
        buildCheckActivatedEmailQuery(email, input.trackCode)
      );
      activatedUser = extractActivatedEmailUser(rawPayload);
    } catch {
      // Ignore lookup failures so code delivery can continue.
    }

    const payload = await callDirectRegisterEmail(runtime, input, email);
    return {
      message: `Verification email sent to ${email}`,
      verificationCode: pickString(payload, ["returnedAccessCode", "confirmCode", "accessCode"]) ?? undefined,
      verificationFlow: "register",
      expectedDtUserId: activatedUser?.dtUserId,
      expectedDingtoneId: activatedUser?.dingtoneId
    };
  }

  async login(input: DingtoneLoginInput): Promise<DingtoneLoginResult> {
    if (input.loginType !== "email_code") {
      throw new AppError("Direct verification login currently supports email_code only.", 501, 501);
    }
    assertActivationDeviceId(input.deviceId, input.appVariant);
    const email = normalizeEmailLoginTarget(input.email);
    const code = normalizeActivationCode(input.verificationCode);
    const runtime = await getDirectRuntimeConfig();
    const payload = await callDirectActivationApi(
      runtime,
      { appVariant: input.appVariant, deviceId: input.deviceId },
      "activateEmail",
      "activateEmail",
      buildActivateEmailQuery(input, runtime, email, code)
    );
    assertDirectActivationOk(payload, "activateEmail");
    const dtUserId = pickString(payload, ["dtUserId", "dt_user_id", "userId", "userID", "UserId", "uid", "UserID"]);
    const token = pickString(payload, ["token", "loginToken", "dtToken", "Token"]);
    if (!dtUserId || !token) {
      throw new AppError(`Direct activateEmail succeeded but did not return userId/token: ${redactSensitiveText(safeJsonStringify(payload))}`, 502, 502);
    }
    const templateDeviceId = await extractConfiguredActivationTemplateDeviceId(
      activationTemplateSettingKeys("activateEmail", { appVariant: input.appVariant, deviceId: input.deviceId }),
      code
    );
    return {
      dtUserId,
      token,
      deviceId: normalizeActivationDeviceIdForVariant(input.deviceId ?? templateDeviceId ?? extractActivationDeviceId(payload) ?? "", input.appVariant),
      dingtoneId: pickString(payload, ["dingtoneId", "dingtoneID", "DingtoneId", "DingtoneID"])
    };
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
    appVariant?: "dingtone" | "dingdong";
  }): Promise<DingtoneSnapshot> {
    const runtime = await getDirectRuntimeConfig();
    return this.withSession(runtime, account, async (session) => {
      const nextTrackCode = () => session.nextTrackCode();
      const shared = {
        deviceId: accountDeviceId(account),
        trackCode: nextTrackCode(),
        userId: account.dtUserId,
        token: account.token,
        appVersion: runtime.appVersion,
        apkCertificateSign: resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)
      };
      const fallbackBalance = await callBestBalanceCommonRestJson(
        session,
        "getBalanceCommonRest",
        "billing/user/getBalance",
        buildGetBalanceQueryAttempts(account, runtime, nextTrackCode)
      );
      let balance = fallbackBalance;
      if (!hasPositiveBalancePayload(balance)) {
        const templateBalance = await session.callJson("getBalance", {
          ...shared,
          trackCode: nextTrackCode()
        }).catch((error) => ({
          refreshError: error instanceof Error ? error.message : String(error)
        }));
        if (hasPositiveBalancePayload(templateBalance)) {
          balance = templateBalance;
        } else if (!isRecord(balance) || !balance.refreshError) {
          balance = {
            ...balance,
            directTemplateFallback: {
              apiName: "billing/user/getBalance",
              result: templateBalance
            }
          };
        }
      }
      const profile = await collectDirectProfileSnapshot(session, runtime, account, shared, nextTrackCode);
      const point = await collectDirectPointSnapshot(session, runtime, account, nextTrackCode);
      const userSetting = await session.callJson("getUserSetting", {
        ...shared,
        trackCode: nextTrackCode(),
        clientUserId: account.dtUserId
      }).catch((error) => ({
        refreshError: error instanceof Error ? error.message : String(error)
      }));
      cacheAccountPhoneCountryKeys(account.dtUserId, [balance, userSetting]);

      return buildSnapshot({
        account,
        balance,
        userSetting,
        profile,
        point
      });
    });
  }

  async listPhoneNumbers(account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" }): Promise<DingtonePhoneNumber[]> {
    const nativeProbe = await runDirectSessionProbe({
      account,
      listenSeconds: 0,
      maxPushFrames: 0,
      focusCall: "getPrivateNumber"
    }).catch(() => null);
    const nativePayload = nativeProbe?.calls.find((call) => call.name === "getPrivateNumber" && call.payload)?.payload;
    if (nativePayload) {
      const phones = normalizePhoneNumbers(nativePayload);
      if (phones.length > 0 || hasPhoneListPayload(nativePayload)) {
        return phones;
      }
    }

    const runtime = await getDirectRuntimeConfig();
    return this.withSession(runtime, account, async (session) => {
      const nextTrackCode = () => session.nextTrackCode();
      const shared = {
        deviceId: accountDeviceId(account),
        userId: account.dtUserId,
        token: account.token,
        clientVersion: runtime.appVersion,
        appVersion: runtime.appVersion,
        apkCertificateSign: resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)
      };
      let lastError: unknown;

      try {
        const payload = await session.callJson("getPrivateNumber", {
          ...shared,
          trackCode: nextTrackCode()
        });
        assertDirectApiSuccess(payload, "listPhoneNumbers");
        const phones = normalizePhoneNumbers(payload);
        if (phones.length > 0 || hasPhoneListPayload(payload)) {
          return phones;
        }
        lastError = new Error("getPrivateNumber returned no phone list");
      } catch (error) {
        lastError = error;
      }

      for (const [index, query] of buildGetPrivateNumberListQueryAttempts(account, runtime, nextTrackCode).entries()) {
        try {
          const payload = await session.callCommonRestJson(
            index === 0 ? "getPrivateNumberListFallback" : `getPrivateNumberListFallback#${index + 1}`,
            "/pstn/share/getPrivateNumber",
            query,
            DIRECT_REFRESH_ATTEMPT_TIMEOUT_MS
          );
          assertDirectApiSuccess(payload, "listPhoneNumbers");
          const phones = normalizePhoneNumbers(payload);
          if (phones.length > 0 || hasPhoneListPayload(payload)) {
            return phones;
          }
          lastError = new Error("getPrivateNumber returned no phone list");
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "getPrivateNumber returned no phone list"));
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
    const requestConfig = resolvePrivatePhoneRequestConfig(payload.countryCode, payload.isoCountryCode, payload.countryKey);
    const previews: DingtonePhonePurchasePreview[] = [];
    let directError: unknown;

    for (let index = 0; index < 200; index += 1) {
      try {
        const result = await this.withSession(runtime, account, async (session) => {
          const attempts = buildRequestPrivateNumberQueryAttempts(account, runtime, requestConfig, () => session.nextTrackCode(), payload.areaCode);
          const query = attempts[index];
          if (!query) {
            throw new Error("No more requestPrivateNumber parameter attempts");
          }
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
        }, 1);
        previews.push(result);
        if (result.candidates.length > 0) {
          return result;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "No more requestPrivateNumber parameter attempts") {
          break;
        }
        directError = error;
        logger.warn("Direct requestPrivateNumber attempt failed; trying next app-compatible parameter set", {
          countryCode: requestConfig.countryCode,
          isoCountryCode: requestConfig.isoCountryCode,
          attempt: index + 1,
          error: error instanceof Error ? error.message : String(error)
        });
        if (isDirectTransportError(error)) {
          break;
        }
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

  async enablePhoneNumberSmsReception(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: DirectPhoneActionContext
  ): Promise<Partial<DingtonePhoneNumber>> {
    const context = { ...phone, phoneNumber };
    const suspendFlag = context.status === "paused" ? 1 : 0;
    const result = await this.callDirectPhoneAction(
      "enableSmsReceive",
      account,
      () => buildPrivateNumberSettingQuery(account, context, suspendFlag),
      "dt_direct_template_phone_setting",
      buildPhoneTemplateParams(context, { phoneNumber, action: "enable-sms", allowReceiveSMS: 1, suspendFlag }),
      { acceptSocketCloseAfterWrite: true }
    );
    assertDirectApiSuccess(result, "enableSmsReceive");
    return {
      phoneNumber,
      allowReceiveSms: true,
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
    handler: (session: DirectSession) => Promise<T>,
    maxAttempts = 2
  ): Promise<T> {
    if (await preemptActiveDirectPushListener(account)) {
      await delay(750);
    }
    return runWithDirectSessionOperationLock(account, async () => {
    const hosts = uniqueHosts([runtime.primaryHost, runtime.backupHost]);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
      if (attempt < maxAttempts) {
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
  focusCall?: "getBalance" | "getUserSetting" | "getPrivateNumber";
}): Promise<DirectProbeResult> {
  const runtime = await getDirectRuntimeConfig();
  const hosts = uniqueHosts([runtime.primaryHost, runtime.backupHost]);
  let lastError: unknown;

  for (const host of hosts) {
    const session = new DirectSession(runtime, host);
    try {
      await session.open(input.account);
      const calls = await runProbeCalls(session, runtime, input.account, input.customTemplates ?? [], input.phonePreviewCountryCode, input.focusCall);
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
    appVariant?: "dingtone" | "dingdong";
  };
  listenSeconds: number;
  maxPushFrames?: number;
  onPush?: (push: DirectProbePushResult) => Promise<void> | void;
  onFrame?: (push: DirectProbePushResult, host: string) => Promise<void> | void;
  onWebOfflineMessages?: (messages: DirectWebOfflineMessage[], host: string) => Promise<void> | void;
  onOfflineCatchup?: (status: {
    host: string;
    reason: "startup" | "interval" | "notify-only";
    attempted: boolean;
    sent: boolean;
    sendCount: number;
    error: string | null;
  }) => Promise<void> | void;
  onHostStatus?: (status: {
    host: string;
    state: "connecting" | "connected" | "failed";
    error: string | null;
  }) => Promise<void> | void;
  shouldContinue?: () => boolean;
  onListenWindowExtended?: () => Promise<void> | void;
}) {
  const runtime = await getDirectRuntimeConfig();
  const baseHosts = getPrioritizedDirectPushHosts(runtime, input.account);
  const maxPushFrames = input.maxPushFrames ?? Number.MAX_SAFE_INTEGER;
  const listenWindowMs = Math.max(1, input.listenSeconds) * 1000;
  let deadline = Date.now() + listenWindowMs;
  const hasRemainingListenWindow = () => {
    const previousDeadline = deadline;
    const nextDeadline = extendDirectListenDeadlineForTest(deadline, listenWindowMs, input.shouldContinue);
    if (nextDeadline === null) {
      return false;
    }
    deadline = nextDeadline;
    if (nextDeadline > previousDeadline) {
      void Promise.resolve(input.onListenWindowExtended?.()).catch((error) => {
        logger.warn("Direct listen window extension callback failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return true;
  };
  const isWithinCurrentListenWindow = () => Date.now() < deadline;
  const pushes: DirectProbePushResult[] = [];
  const trace: DirectProbeFrameTrace[] = [];
  let offlineTemplateSent = false;
  let offlineTemplateError: string | null = null;
  let offlineTemplateAttempted = false;
  let offlineTemplateSendCount = 0;
  let offlineCatchupInFlight: Promise<void> | null = null;
  let webOfflinePollInFlight: Promise<void> | null = null;
  const calls: DirectProbeCallResult[] = [];
  let resolveListenerDone!: () => void;
  const listenerDone = new Promise<void>((resolve) => {
    resolveListenerDone = resolve;
  });
  const listener: ActiveDirectPushListener = {
    key: directSessionAccountKey(input.account),
    preempted: false,
    sessions: new Set(),
    done: listenerDone,
    resolveDone: resolveListenerDone
  };
  let lastError: unknown;
  let selectedHost = baseHosts[0] ?? runtime.primaryHost;
  let attempts = 0;
  let successfulPairs = 0;
  let nextOfflineCatchupAt = 0;
  let nextNotifyOnlyCatchupAt = 0;
  let nextWebOfflinePollAt = 0;

  await preemptActiveDirectPushListener(input.account);
  activeDirectPushListeners.set(listener.key, listener);

  const reportHostStatus = async (
    host: string,
    state: "connecting" | "connected" | "failed",
    error: string | null
  ) => {
    try {
      await input.onHostStatus?.({ host, state, error });
    } catch (callbackError) {
      logger.warn("Direct host status callback failed", {
        host,
        state,
        error: callbackError instanceof Error ? callbackError.message : String(callbackError)
      });
    }
  };

  const requestOfflineCatchup = async (session: DirectSession, host: string, reason: "startup" | "interval" | "notify-only") => {
    if (offlineCatchupInFlight) {
      await offlineCatchupInFlight;
      return;
    }
    offlineCatchupInFlight = (async () => {
      offlineTemplateAttempted = true;
      try {
        const sent = await session.sendConfiguredTemplate("dt_direct_template_offline_messages", input.account, {
          action: "requestAllOfflineMessage"
        });
        offlineTemplateSent = offlineTemplateSent || sent;
        if (sent) {
          offlineTemplateSendCount += 1;
          offlineTemplateError = null;
          logger.info("Direct offline message catch-up template sent", {
            host,
            reason,
            sendCount: offlineTemplateSendCount
          });
        } else {
          offlineTemplateError = offlineTemplateError ?? "dt_direct_template_offline_messages is not configured";
        }
      } catch (error) {
        offlineTemplateError = error instanceof Error ? error.message : String(error);
        logger.warn("Direct offline message template was not sent", {
          host,
          reason,
          error: offlineTemplateError
        });
      } finally {
        nextOfflineCatchupAt = offlineTemplateError ? Date.now() + DIRECT_OFFLINE_CATCHUP_RETRY_MS : deadline;
        try {
          await input.onOfflineCatchup?.({
            host,
            reason,
            attempted: offlineTemplateAttempted,
            sent: offlineTemplateSent,
            sendCount: offlineTemplateSendCount,
            error: offlineTemplateError
          });
        } catch (error) {
          logger.warn("Direct offline catch-up status callback failed", {
            host,
            reason,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        offlineCatchupInFlight = null;
      }
    })();
    await offlineCatchupInFlight;
  };

  const requestWebOfflineMessages = async (session: DirectSession, host: string) => {
    if (webOfflinePollInFlight) {
      await webOfflinePollInFlight;
      return;
    }
    webOfflinePollInFlight = (async () => {
      const payload = await session.callJsonFromTemplate("getWebOfflineMessage", TEMPLATES.getWebOfflineMessage, {
        deviceId: accountDeviceId(input.account),
        userId: input.account.dtUserId,
        token: input.account.token,
        TrackCode: session.nextTrackCode(),
        bDevice: 1
      });
      const messages = normalizeDirectWebOfflineMessages(payload, input.account.appVariant);
      await deliverDirectWebOfflineMessages(
        messages,
        host,
        input.onWebOfflineMessages,
        getDirectWebOfflineDeliveryTracker(input.account)
      );
    })()
      .catch((error) => {
        logger.warn("Direct web-offline message poll failed", {
          host,
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        nextWebOfflinePollAt = Date.now() + DIRECT_WEB_OFFLINE_POLL_INTERVAL_MS;
        webOfflinePollInFlight = null;
      });
    await webOfflinePollInFlight;
  };

  const hostErrors: unknown[] = [];

  try {
    const discoveredHosts = input.shouldContinue
      ? await (async () => {
          const discoverySession = new DirectSession(runtime, baseHosts[0] ?? runtime.primaryHost);
          listener.sessions?.add(discoverySession);
          try {
            return await discoverDirectPushHostsForListener(discoverySession, runtime, input.account);
          } catch (error) {
            logger.warn("Direct account gateway discovery failed; using known SMS gateways", {
              dtUserId: input.account.dtUserId,
              error: error instanceof Error ? error.message : String(error)
            });
            return [];
          } finally {
            listener.sessions?.delete(discoverySession);
            await discoverySession.close().catch(() => undefined);
          }
        })()
      : [];
    if (input.shouldContinue) {
      deadline = Date.now() + listenWindowMs;
    }
    const hosts = uniqueHosts([baseHosts[0] ?? runtime.primaryHost, ...discoveredHosts, ...baseHosts]);
    const workerHosts = hosts.slice(0, DIRECT_PUSH_HOST_CONCURRENCY);
    const registrationOwnerHost = workerHosts[0] ?? runtime.primaryHost;
    const routeCoordinator = createDirectRouteCoordinator(registrationOwnerHost);
    const runPairedHostWorker = async (host: string) => {
      while (!listener.preempted && hasRemainingListenWindow() && pushes.length < maxPushFrames) {
      const operationIdle = await waitForDirectSessionOperationIdle(input.account, DIRECT_SESSION_OPERATION_IDLE_WAIT_MS);
      if (!operationIdle) {
        logger.warn("Direct session operation remained busy; starting SMS listener anyway", {
          dtUserId: input.account.dtUserId,
          waitMs: DIRECT_SESSION_OPERATION_IDLE_WAIT_MS
        });
      }
      if (listener.preempted || !isWithinCurrentListenWindow() || pushes.length >= maxPushFrames) {
        break;
      }

      const pushSession = new DirectSession(runtime, host);
      let linkSession: DirectSession | null = null;
      let linkRegistrationEpoch: number | null = null;
      listener.session = pushSession;
      listener.sessions?.add(pushSession);
      if (!isActiveDirectPushListener(listener)) {
        await pushSession.close().catch(() => undefined);
        listener.sessions?.delete(pushSession);
        break;
      }
      attempts += 1;
      selectedHost = host;
      await reportHostStatus(host, "connecting", null);
      let pushTraceCount = 0;
      let linkTraceCount = 0;
      const collectPairTrace = () => {
        const pushTrace = pushSession.getTrace();
        trace.push(...pushTrace.slice(pushTraceCount));
        pushTraceCount = pushTrace.length;
        if (linkSession) {
          const linkTrace = linkSession.getTrace();
          trace.push(...linkTrace.slice(linkTraceCount));
          linkTraceCount = linkTrace.length;
        }
      };
      const closeLinkSession = async () => {
        if (!linkSession) {
          return;
        }
        collectPairTrace();
        const closingSession = linkSession;
        linkSession = null;
        linkTraceCount = 0;
        if (linkRegistrationEpoch !== null) {
          linkRegistrationEpoch = null;
        }
        listener.sessions?.delete(closingSession);
        await closingSession.close().catch(() => undefined);
      };
      const ensureRouteRegistration = async (currentLinkSession: DirectSession) => {
        if (linkRegistrationEpoch !== null && routeCoordinator.isOwner(host, linkRegistrationEpoch)) {
          return true;
        }
        if (!routeCoordinator.shouldClaim(host)) {
          logger.info("Direct secondary paired workers stay authenticated without replacing the primary SMS route", {
            host,
            registrationOwnerHost,
            routeOwnerHost: routeCoordinator.ownerHost()
          });
          return false;
        }
        if (!isActiveDirectPushListener(listener)) {
          throw new Error("Direct listener was preempted before route registration");
        }
        const reservedEpoch = routeCoordinator.claim(host);
        try {
          if (!isActiveDirectPushListener(listener)) {
            throw new Error("Direct listener was preempted before route registration");
          }
          calls.push(await runPushLinkRegistration(currentLinkSession, runtime, input.account));
          const registration = calls[calls.length - 1];
          if (!registration?.ok) {
            throw new Error(registration?.error ?? "Direct paired link registration failed");
          }
          if (!isActiveDirectPushListener(listener)) {
            throw new Error("Direct listener was preempted during route registration");
          }
          linkRegistrationEpoch = reservedEpoch;
          logger.info("Direct paired worker owns the SMS route", {
            host,
            registrationOwnerHost
          });
          return true;
        } catch (error) {
          routeCoordinator.release(host, reservedEpoch);
          if (host === registrationOwnerHost) {
            routeCoordinator.markPrimaryUnavailable();
          }
          throw error;
        }
      };
      const ensureLinkSession = async () => {
        if (linkSession?.isOpen()) {
          return linkSession;
        }
        if (!isActiveDirectPushListener(listener)) {
          throw new Error("Direct listener was preempted before link session creation");
        }
        await closeLinkSession();
        linkSession = new DirectSession(runtime, host);
        listener.sessions?.add(linkSession);
        try {
          await linkSession.openLink(input.account);
          if (!isActiveDirectPushListener(listener)) {
            throw new Error("Direct listener was preempted after link authentication");
          }
          calls.push(...(await runPushMaintenanceCalls(linkSession, runtime, input.account)));
          if (!isActiveDirectPushListener(listener)) {
            throw new Error("Direct listener was preempted during private-number refresh");
          }
          await ensureRouteRegistration(linkSession);
          successfulPairs += 1;
          await reportHostStatus(host, "connected", null);
          offlineTemplateAttempted = true;
          offlineTemplateSent = true;
          offlineTemplateSendCount += 1;
          offlineTemplateError = null;
          nextOfflineCatchupAt = deadline;
          if (nextWebOfflinePollAt <= 0) {
            nextWebOfflinePollAt = Date.now() + DIRECT_WEB_OFFLINE_POLL_INTERVAL_MS;
          }
          try {
            await input.onOfflineCatchup?.({
              host,
              reason: "startup",
              attempted: true,
              sent: true,
              sendCount: offlineTemplateSendCount,
              error: null
            });
          } catch (error) {
            logger.warn("Direct offline catch-up status callback failed", {
              host,
              reason: "startup",
              error: error instanceof Error ? error.message : String(error)
            });
          }
          return linkSession;
        } catch (error) {
          collectPairTrace();
          await closeLinkSession();
          throw error;
        }
      };
      const handlePairedFrame = async (push: DirectProbePushResult, frameHost: string) => {
        if (push.sms) {
          rememberDirectSmsHost(input.account, frameHost);
        }
        if (isNotifyOnlyMessageIndexPush(push) && Date.now() >= nextNotifyOnlyCatchupAt) {
          nextNotifyOnlyCatchupAt = Date.now() + DIRECT_NOTIFY_ONLY_CATCHUP_THROTTLE_MS;
          try {
            const currentLinkSession = await ensureLinkSession();
            await requestOfflineCatchup(currentLinkSession, host, "notify-only");
          } catch (error) {
            logger.warn("Direct notify-only catch-up could not refresh the paired link", {
              host,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        await input.onFrame?.(push, frameHost);
      };

      try {
        await pushSession.openPush(input.account);

        while (!listener.preempted && isWithinCurrentListenWindow() && pushes.length < maxPushFrames) {
          let currentLinkSession: DirectSession;
          try {
            currentLinkSession = await ensureLinkSession();
            await ensureRouteRegistration(currentLinkSession);
            lastError = undefined;
          } catch (error) {
            lastError = error;
            hostErrors.push(error);
            logger.warn("Direct paired link registration failed; keeping push socket open", {
              host,
              pushAttempt: attempts,
              error: error instanceof Error ? error.message : String(error)
            });
            if (isFatalDirectSessionError(error)) {
              throw normalizeDirectError(error);
            }
            await delay(Math.min(DIRECT_RECONNECT_BACKOFF_MAX_MS, 500));
            continue;
          }
          const remainingFrames = Math.max(0, maxPushFrames - pushes.length);
          if (remainingFrames <= 0) {
            break;
          }
          const waitUntil = Math.min(
            deadline,
            nextOfflineCatchupAt > 0 ? nextOfflineCatchupAt : deadline,
            nextWebOfflinePollAt > 0 ? nextWebOfflinePollAt : deadline
          );
          const waitMs = Math.max(250, Math.min(5_000, waitUntil - Date.now()));
          const linkWaitMs = Math.max(250, Math.ceil(waitMs / 2));
          const nextPushes: DirectProbePushResult[] = [];
          try {
            nextPushes.push(
              ...(await currentLinkSession.waitForPushes(
                linkWaitMs,
                remainingFrames,
                input.onPush,
                handlePairedFrame
              ))
            );
          } catch (error) {
            lastError = error;
            hostErrors.push(error);
            logger.warn("Direct registered link read failed; keeping prelogin socket open", {
              host,
              pushAttempt: attempts,
              error: error instanceof Error ? error.message : String(error)
            });
            if (linkSession === currentLinkSession) {
              await closeLinkSession();
            }
            if (isFatalDirectSessionError(error)) {
              throw normalizeDirectError(error);
            }
          }
          const remainingAfterLink = Math.max(0, remainingFrames - nextPushes.length);
          if (remainingAfterLink > 0) {
            const pushWaitMs = Math.max(250, waitMs - linkWaitMs);
            nextPushes.push(
              ...(await pushSession.waitForPushes(pushWaitMs, remainingAfterLink, input.onPush, handlePairedFrame))
            );
          }
          pushes.push(...nextPushes);
          collectPairTrace();
          lastError = undefined;
          if (listener.preempted || !isWithinCurrentListenWindow() || pushes.length >= maxPushFrames) {
            break;
          }
          if (Date.now() >= nextOfflineCatchupAt) {
            const currentLinkSession = await ensureLinkSession();
            await requestOfflineCatchup(currentLinkSession, host, "interval");
          }
          if (Date.now() >= nextWebOfflinePollAt) {
            const currentLinkSession = await ensureLinkSession();
            await requestWebOfflineMessages(currentLinkSession, host);
          }
        }
      } catch (error) {
        lastError = error;
        hostErrors.push(error);
        if (host === registrationOwnerHost) {
          routeCoordinator.markPrimaryUnavailable();
        }
        await reportHostStatus(host, "failed", error instanceof Error ? error.message : String(error));
        collectPairTrace();
        if (!listener.preempted) {
          logger.warn("Direct paired push listen failed, reconnecting inside listen window", {
            host,
            attempt: attempts,
            error: error instanceof Error ? error.message : String(error)
          });
          if (isFatalDirectSessionError(error)) {
            throw normalizeDirectError(error);
          }
          const backoffMs = Math.min(DIRECT_RECONNECT_BACKOFF_MAX_MS, 250 + Math.min(attempts, 3) * 250);
          if (isWithinCurrentListenWindow() && Date.now() + backoffMs < deadline) {
            await delay(backoffMs);
          }
        }
      } finally {
        await closeLinkSession();
        await pushSession.close().catch(() => undefined);
        listener.sessions?.delete(pushSession);
        if (listener.session === pushSession) {
          listener.session = undefined;
        }
      }
      }
    };

    await Promise.allSettled(workerHosts.map(runPairedHostWorker));

    const fatalError = hostErrors.find((error) => isFatalDirectSessionError(error));
    if (fatalError && successfulPairs === 0) {
      throw normalizeDirectError(fatalError);
    }
  } finally {
    if (activeDirectPushListeners.get(listener.key) === listener) {
      activeDirectPushListeners.delete(listener.key);
    }
    if (listener.preempted && !offlineTemplateAttempted && !offlineTemplateError) {
      offlineTemplateError = "direct listener was preempted before offline template could be sent";
    }
    listener.resolveDone();
  }

  if (attempts === 0 && lastError) {
    throw normalizeDirectError(lastError);
  }

  if (!listener.preempted && successfulPairs === 0 && lastError) {
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
    offlineTemplateSendCount,
    offlineTemplateError,
    preempted: listener.preempted
  };
}

export function extendDirectListenDeadlineForTest(
  deadline: number,
  listenWindowMs: number,
  shouldContinue?: () => boolean,
  now = Date.now()
) {
  if (now < deadline) {
    return deadline;
  }
  return shouldContinue?.() ? now + Math.max(1, listenWindowMs) : null;
}

async function pollWebOfflineMessagesOnGatewayHosts(
  runtime: DirectRuntimeConfig,
  account: DirectSessionAccount,
  onMessages?: (messages: DirectWebOfflineMessage[], host: string) => Promise<void> | void,
  deliveryTracker?: DirectWebOfflineDeliveryTracker
) {
  let lastError: unknown;
  for (const host of uniqueHosts([runtime.primaryHost, runtime.backupHost])) {
    const session = new DirectSession(runtime, host);
    try {
      await session.open(account);
      const payload = await session.callJsonFromTemplate("getWebOfflineMessage", TEMPLATES.getWebOfflineMessage, {
        deviceId: accountDeviceId(account),
        userId: account.dtUserId,
        token: account.token,
        TrackCode: session.nextTrackCode(),
        bDevice: 1
      });
      const messages = normalizeDirectWebOfflineMessages(payload, account.appVariant);
      await deliverDirectWebOfflineMessages(messages, host, onMessages, deliveryTracker);
      await session.close();
      return;
    } catch (error) {
      lastError = error;
      await session.close().catch(() => undefined);
    }
  }
  throw normalizeDirectError(lastError ?? new Error("No direct gateway host accepted getUserOfflineMsg"));
}

export async function probeDirectPushSocket(input: {
  account: DirectSessionAccount;
  host?: string;
  listenSeconds: number;
  maxPushFrames?: number;
  onPush?: (push: DirectProbePushResult) => Promise<void> | void;
  onFrame?: (push: DirectProbePushResult, host: string) => Promise<void> | void;
}) {
  const runtime = await getDirectRuntimeConfig();
  const host = input.host ?? getPrioritizedDirectPushHosts(runtime, input.account)[0] ?? runtime.primaryHost;
  const maxPushFrames = input.maxPushFrames ?? Number.MAX_SAFE_INTEGER;
  const deadline = Date.now() + Math.max(1, input.listenSeconds) * 1_000;
  const startedAt = Date.now();
  const pushSession = new DirectSession(runtime, host);
  const linkSession = new DirectSession(runtime, host);
  const calls: DirectProbeCallResult[] = [];
  const pushes: DirectProbePushResult[] = [];
  let error: string | null = null;

  const onPush = async (push: DirectProbePushResult) => {
    await input.onPush?.(push);
  };
  const onFrame = async (push: DirectProbePushResult, frameHost: string) => {
    if (push.sms) {
      rememberDirectSmsHost(input.account, frameHost);
    }
    await input.onFrame?.(push, frameHost);
  };

  try {
    await pushSession.openPush(input.account);
    await linkSession.openLink(input.account);
    calls.push(await runPushLinkRegistration(linkSession, runtime, input.account));
    while (Date.now() < deadline && pushes.length < maxPushFrames) {
      const waitMs = Math.max(250, Math.min(5_000, deadline - Date.now()));
      const batchLimit = Math.max(1, maxPushFrames - pushes.length);
      const linkWaitMs = Math.max(250, Math.ceil(waitMs / 2));
      const linkSocketFrames = await linkSession.waitForPushes(linkWaitMs, batchLimit, onPush, onFrame).catch((caught) => {
        throw annotatePairedSocketError("link", caught);
      });
      pushes.push(...linkSocketFrames);
      const remainingFrames = Math.max(0, maxPushFrames - pushes.length);
      if (remainingFrames <= 0) {
        break;
      }
      const pushWaitMs = Math.max(250, waitMs - linkWaitMs);
      const pushSocketFrames = await pushSession.waitForPushes(pushWaitMs, remainingFrames, onPush, onFrame).catch((caught) => {
        throw annotatePairedSocketError("push", caught);
      });
      pushes.push(...pushSocketFrames);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await Promise.all([
      pushSession.close().catch(() => undefined),
      linkSession.close().catch(() => undefined)
    ]);
  }

  return {
    ok: error === null,
    host,
    durationMs: Date.now() - startedAt,
    endedEarly: error !== null && Date.now() < deadline,
    error,
    calls,
    pushes,
    trace: [...pushSession.getTrace(), ...linkSession.getTrace()],
    pushTrace: pushSession.getTrace(),
    linkTrace: linkSession.getTrace()
  };
}

function annotatePairedSocketError(role: "push" | "link", caught: unknown) {
  const message = caught instanceof Error ? caught.message : String(caught);
  return new Error(`${role} socket: ${message}`);
}

export async function fetchDirectWebOfflineMessages(account: DirectSessionAccount) {
  const runtime = await getDirectRuntimeConfig();
  let collected: DirectWebOfflineMessage[] = [];
  await pollWebOfflineMessagesOnGatewayHosts(runtime, account, (messages) => {
    collected = messages;
  });
  return collected;
}

type DirectWebOfflineDeliveryCandidate = {
  msgId?: string | null;
  conversationId?: string | null;
  type?: number | null;
  senderId?: string | null;
  content: string;
  timestamp?: number | null;
};

class DirectWebOfflineDeliveryTracker {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries = 1_000) {}

  selectUnseen<T extends DirectWebOfflineDeliveryCandidate>(messages: T[]) {
    const batchKeys = new Set<string>();
    return messages.filter((message) => {
      const key = directWebOfflineDeliveryKey(message);
      if (this.seen.has(key) || batchKeys.has(key)) {
        return false;
      }
      batchKeys.add(key);
      return true;
    });
  }

  remember(messages: DirectWebOfflineDeliveryCandidate[]) {
    for (const message of messages) {
      const key = directWebOfflineDeliveryKey(message);
      this.seen.delete(key);
      this.seen.add(key);
    }
    while (this.seen.size > Math.max(1, this.maxEntries)) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.seen.delete(oldest);
    }
  }
}

function directWebOfflineDeliveryKey(message: DirectWebOfflineDeliveryCandidate) {
  const msgId = message.msgId?.trim();
  if (msgId) {
    return `id:${msgId}`;
  }
  return `signature:${JSON.stringify([
    message.conversationId ?? null,
    message.type ?? null,
    message.senderId ?? null,
    message.timestamp ?? null,
    message.content
  ])}`;
}

function getDirectWebOfflineDeliveryTracker(account: DirectSessionAccount) {
  const key = directSessionAccountKey(account);
  let tracker = directWebOfflineDeliveryTrackers.get(key);
  if (!tracker) {
    tracker = new DirectWebOfflineDeliveryTracker();
    directWebOfflineDeliveryTrackers.set(key, tracker);
  }
  return tracker;
}

async function deliverDirectWebOfflineMessages<T extends DirectWebOfflineDeliveryCandidate>(
  messages: T[],
  host: string,
  onMessages?: (messages: T[], host: string) => Promise<void> | void,
  deliveryTracker?: DirectWebOfflineDeliveryTracker
) {
  if (!onMessages || messages.length === 0) {
    return;
  }
  const unseen = deliveryTracker?.selectUnseen(messages) ?? messages;
  if (unseen.length === 0) {
    return;
  }
  await onMessages(unseen, host);
  deliveryTracker?.remember(unseen);
}

export function createDirectWebOfflineDeliveryTrackerForTest(maxEntries?: number) {
  return new DirectWebOfflineDeliveryTracker(maxEntries);
}

export async function deliverDirectWebOfflineMessagesForTest<T extends DirectWebOfflineDeliveryCandidate>(
  messages: T[],
  host: string,
  onMessages: (messages: T[], host: string) => Promise<void> | void,
  deliveryTracker: DirectWebOfflineDeliveryTracker
) {
  await deliverDirectWebOfflineMessages(messages, host, onMessages, deliveryTracker);
}

async function discoverDirectPushHostsForListener(
  session: DirectSession,
  runtime: DirectRuntimeConfig,
  account: DirectSessionAccount
) {
  await session.openLink(account);
  const payload = await session.callJsonFromTemplate(
    "queryRtcServersEx",
    TEMPLATES.queryRtcServersEx,
    {
      ...buildSharedTemplateParams(account, runtime),
      trackCode: session.nextTrackCode()
    },
    Math.min(runtime.ioTimeoutMs, 5_000)
  );
  const hosts = extractRtcServerHosts(payload);
  logger.info("Direct account gateway discovery completed", {
    dtUserId: account.dtUserId,
    hosts
  });
  return hosts;
}

async function runPushMaintenanceCalls(
  session: DirectSession,
  runtime: DirectRuntimeConfig,
  account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
    appVariant?: "dingtone" | "dingdong";
  },
  fullPrime = true
) {
  if (!fullPrime || account.appVariant !== "dingtone") {
    return [];
  }
  const appVersion = resolveDirectAppVersion(account, runtime);
  const shared = {
    deviceId: accountDeviceId(account),
    userId: account.dtUserId,
    token: account.token,
    clientVersion: appVersion,
    appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)
  };
  const nextTrackCode = () => session.nextTrackCode();
  const calls: DirectProbeCallResult[] = [];
  calls.push(
    await sendPushTemplateCall(
      session,
      "listenPrime.getPrivateNumber",
      "getPrivateNumber",
      { ...shared, trackCode: nextTrackCode() }
    )
  );
  return calls;
}

async function runPushLinkRegistration(
  session: DirectSession,
  runtime: DirectRuntimeConfig,
  account: DirectSessionAccount
) {
  const appVersion = resolveDirectAppVersion(account, runtime);
  return sendPushTemplateCall(session, "listenPrime.updateClientLink", "updateClientLink", {
    deviceId: accountDeviceId(account),
    userId: account.dtUserId,
    token: account.token,
    clientVersion: appVersion,
    appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign),
    trackCode: session.nextTrackCode()
  });
}

async function sendPushTemplateCall(
  session: DirectSession,
  name: string,
  templateName: keyof typeof TEMPLATES,
  params: DirectTemplateParams
): Promise<DirectProbeCallResult> {
  const startedAt = Date.now();
  try {
    await session.sendJson(templateName, params);
    return {
      name,
      ok: true,
      durationMs: Date.now() - startedAt,
      payload: { sent: true }
    };
  } catch (error) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runPushListenPrimeCalls(
  session: DirectSession,
  runtime: DirectRuntimeConfig,
  account: DirectSessionAccount,
  fullPrime = true
) {
  const maintenanceCalls = await runPushMaintenanceCalls(session, runtime, account, fullPrime);
  const linkRegistration = await runPushLinkRegistration(session, runtime, account);
  return [...maintenanceCalls, linkRegistration];
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

export function extractRtcServerHostsForTest(payload: ApiResult) {
  return extractRtcServerHosts(payload);
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

export async function preemptDirectSessionPushListener(account: { dtUserId: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" }) {
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

export async function runDirectActivatedUserProbe(input: {
  kind: "email" | "phone";
  target: string;
  deviceId: string;
  appVariant?: "dingtone" | "dingdong";
  countryCode?: number;
}): Promise<DirectActivatedUserProbeResult> {
  assertValidAccessCodeTarget(input.kind, input.target);
  assertActivationDeviceId(input.deviceId, input.appVariant);
  const runtime = await getDirectRuntimeConfig();
  const hosts = uniqueHosts([runtime.primaryHost, runtime.backupHost]);
  const apiNames = [
    "checkActivatedUser",
    "checkUserActivate",
    "checkUserActivated",
    "checkActivatedAccount",
    "activation/checkActivatedUser",
    "user/checkActivatedUser"
  ];
  let lastError: unknown;

  for (const host of hosts) {
    const session = new DirectSession(runtime, host);
    try {
      await session.openActivation({ appVariant: input.appVariant, deviceId: input.deviceId });
      const calls: DirectProbeCallResult[] = [];
      let emptyPayload: ApiResult | undefined;
      for (const apiName of apiNames) {
        const queries = buildCheckActivatedUserQueries(input.kind, input.target, input.countryCode, session.nextTrackCode());
        for (const [queryIndex, query] of queries.entries()) {
          const label = queryIndex === 0 ? apiName : `${apiName}#${queryIndex + 1}`;
          const call = await timeProbeCall(session, label, () => session.callCommonRestJson(label, apiName, query, 2_500));
          const tracedPayload = findLastCommonRestPayload(call.frames ?? [], apiName);
          const payload = call.payload ?? tracedPayload ?? undefined;
          const normalizedCall = tracedPayload && !call.payload ? { ...call, payload, ok: true, error: undefined } : call;
          calls.push(normalizedCall);
          if (hasActivatedUserPayload(payload)) {
            await session.close();
            return {
              ok: true,
              host,
              target: redactAccessCodeTarget(input.kind, input.target),
              calls,
              trace: session.getTrace()
            };
          }
          if (!emptyPayload && hasActivationDefinitiveEmptyPayload(payload)) {
            emptyPayload = payload;
          }
        }
      }
      await session.close();
      return {
        ok: calls.some((call) => hasActivatedUserPayload(call.payload)) || (!emptyPayload && calls.some((call) => call.ok)),
        host,
        target: redactAccessCodeTarget(input.kind, input.target),
        calls,
        trace: session.getTrace()
      };
    } catch (error) {
      lastError = error;
      await session.close().catch(() => undefined);
      logger.warn("Direct activated-user probe failed, trying next endpoint", {
        host,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  throw normalizeDirectError(lastError);
}

export async function verifyDirectActivationAccessCode(input: {
  kind: "email" | "phone";
  target: string;
  accessCode: string | number;
  deviceId: string;
  appVariant?: "dingtone" | "dingdong";
  countryCode?: number;
}) {
  assertValidAccessCodeTarget(input.kind, input.target);
  const code = String(input.accessCode).trim();
  if (!code) {
    throw new AppError("accessCode is required", 400, 400);
  }
  const runtime = await getDirectRuntimeConfig();
  const payload = await callDirectActivationApi(
    runtime,
    { appVariant: input.appVariant, deviceId: input.deviceId },
    "verifyAccessCode",
    "verifyAccessCode",
    buildVerifyAccessCodeQuery(input.kind, input.target, resolveAccessCodeCountryCode(input.kind, input.target, input.countryCode), code)
  );
  assertDirectActivationOk(payload, "verifyAccessCode");
  return payload;
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
  phonePreviewCountryCode?: number,
  focusCall?: "getBalance" | "getUserSetting" | "getPrivateNumber"
) {
  const shared = {
    deviceId: accountDeviceId(account),
    userId: account.dtUserId,
    token: account.token,
    clientVersion: runtime.appVersion,
    appVersion: runtime.appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)
  };
  const calls: DirectProbeCallResult[] = [];
  const nextTrackCode = () => session.nextTrackCode();

  const standardCalls = [
    { name: "getBalance" as const, params: { ...shared, trackCode: nextTrackCode() } },
    { name: "getUserSetting" as const, params: { ...shared, trackCode: nextTrackCode(), clientUserId: account.dtUserId } },
    { name: "getPrivateNumber" as const, params: { ...shared, trackCode: nextTrackCode() } },
    { name: "followerListInfo" as const, params: { ...shared, trackCode: nextTrackCode() } },
    { name: "infoBus" as const, params: { ...shared, trackCode: nextTrackCode() } }
  ];
  for (const item of focusCall ? standardCalls.filter((candidate) => candidate.name === focusCall) : standardCalls) {
    calls.push(await timeProbeCall(session, item.name, () => session.callJson(item.name, item.params)));
  }

  if (focusCall) {
    return calls;
  }

  calls.push(
    await timeProbeCall(session, "gwebInfoBus", () =>
      session.callCommonRestJson("gwebInfoBus", "gwebsvr/infoBus", buildGwebInfoBusQuery(account, runtime, nextTrackCode()))
    )
  );
  calls.push(
    await timeProbeCall(session, "glbUserPropertites", () =>
      session.callCommonRestJson("glbUserPropertites", "glb/userPropertites", buildGlbUserPropertiesQuery(account, runtime, nextTrackCode()))
    )
  );

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
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
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
    appVersion: resolveDirectAppVersion(account, runtime),
    apkCertificateSign: resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign),
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
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig
): DirectTemplateParams {
  return {
    deviceId: accountDeviceId(account),
    userId: account.dtUserId,
    token: account.token,
    trackCode: createDirectTrackCode(account.dtUserId),
    clientVersion: resolveDirectAppVersion(account, runtime),
    appVersion: resolveDirectAppVersion(account, runtime),
    apkCertificateSign: resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)
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
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig
) {
  const nextTrackCode = () => session.nextTrackCode();
  const shared = {
    deviceId: accountDeviceId(account),
    trackCode: nextTrackCode(),
    userId: account.dtUserId,
    token: account.token,
    clientVersion: runtime.appVersion,
    appVersion: runtime.appVersion,
    apkCertificateSign: resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)
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

function buildDirectSessionKeepaliveFrame(session: Buffer) {
  if (session.length < 4) {
    throw new Error("Direct session keepalive requires a 4-byte session id");
  }
  const frame = Buffer.alloc(17);
  frame[0] = 0x01;
  frame[1] = 0x07;
  frame.writeUInt32BE(17, 2);
  frame.writeUInt16BE(0x8107, 6);
  session.copy(frame, 8, 0, 4);
  frame.writeUInt32BE(1, 12);
  frame[16] = 0xff;
  return frame;
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
  private jsonCaptureUntil = 0;
  private skippedNonSmsLogCount = 0;
  private idleDroppedNonSmsFrameCount = 0;
  private idleSocketPaused = false;
  private idleSocketPauseTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private keepaliveWriteInFlight = false;
  private keepaliveWriteCount = 0;
  private socketConnectedAt = 0;
  private bufferedConsumeScheduled = false;
  private pendingPushes: DirectProbePushResult[] = [];
  private accountPhoneCountryKeys?: Set<string>;
  private account?: DirectSessionAccount;
  private closed = false;
  private sessionId = Buffer.alloc(4);
  private route = Buffer.alloc(8);
  private trace: DirectProbeFrameTrace[] = [];
  private bootstrapPayloads: ApiResult[] = [];
  private pushDeliveryConfirmSerial = 6;
  private trackCodeGenerator: (() => string) | null = null;

  constructor(private runtime: DirectRuntimeConfig, private host: string) {}

  async open(account: DirectSessionAccount) {
    await this.openPrelogin(account);
    await this.startSocketKeepalive();
    await this.bootstrapAuthenticatedSession(account);
  }

  async openPush(account: DirectSessionAccount) {
    await this.openPrelogin(account);
    this.startPairedKeepalive();
  }

  async openLink(account: DirectSessionAccount) {
    await this.openPrelogin(account);
    await this.bootstrapAuthenticatedSession(account);
    await this.primeLinkRegistration(account);
    this.startPairedKeepalive();
  }

  private async primeLinkRegistration(account: DirectSessionAccount) {
    const appVersion = resolveDirectAppVersion(account, this.runtime);
    const shared = {
      deviceId: accountDeviceId(account),
      userId: account.dtUserId,
      token: account.token,
      clientVersion: appVersion,
      appVersion,
      apkCertificateSign: resolveDirectApiApkCertificateSign(account, this.runtime.apkCertificateSign)
    };
    const nextTrackCode = () => this.nextTrackCode();

    await this.sendJson("followerListInfo", { ...shared, trackCode: nextTrackCode() });
    await this.sendJson("getFriendList", { ...shared, trackCode: nextTrackCode() });
    await this.sendJson("infoBus", { ...shared, trackCode: nextTrackCode() });
    const offlineTemplateSent = await this.sendConfiguredTemplate("dt_direct_template_offline_messages", account, {
      action: "requestAllOfflineMessage"
    });
    if (!offlineTemplateSent) {
      throw new Error("Direct offline message template is unavailable");
    }
    await this.sendJson("getBalance", { ...shared, trackCode: nextTrackCode() });
    await this.sendCommonRestJson(
      "glbUserPropertites",
      "glb/userPropertites",
      buildGlbUserPropertiesQuery(account, this.runtime, nextTrackCode())
    );
    await this.sendCommonRestJson(
      "gwebInfoBus",
      "gwebsvr/infoBus",
      buildGwebInfoBusQuery(account, this.runtime, nextTrackCode())
    );
    await this.sendJson("queryRtcServersEx", { ...shared, trackCode: nextTrackCode() });
    await this.sendJson("queryRtcServersEx", { ...shared, trackCode: nextTrackCode() });
    await this.sendCommonRestJson(
      "clientInfo",
      "clientInfo",
      buildDirectSessionClientInfoQuery(account, this.runtime, nextTrackCode())
    );
  }

  private async openPrelogin(account: DirectSessionAccount) {
    this.account = account;
    this.trackCodeGenerator = createDirectTrackCodeGenerator(account.dtUserId);
    this.socket = await this.connectSocket(this.host, this.runtime.port, this.runtime.connectTimeoutMs);
    this.socketConnectedAt = Date.now();
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
  }

  async openActivation(identity: DirectActivationIdentity) {
    const deviceId = activationDeviceId(identity);
    this.trackCodeGenerator = createDirectTrackCodeGenerator(deviceId);
    this.socket = await this.connectSocket(this.host, this.runtime.port, this.runtime.connectTimeoutMs);
    this.socketConnectedAt = Date.now();
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
        deviceID: deviceId,
        notPreLogin: "true",
        userID: 100000000000000
      }
    });
    await this.write(prelogin);

    const preloginResp = await this.waitForFrame(
      (frame) => frame.type === 0x8107 && frame.status === 0x0101,
      this.runtime.ioTimeoutMs,
      "getInfoBeforeLogin response"
    );
    this.route = Buffer.from(preloginResp.body.subarray(8, 16));
  }

  async callJson(
    templateName: keyof typeof TEMPLATES,
    params: DirectTemplateParams,
    timeoutMs = this.runtime.ioTimeoutMs
  ) {
    return this.callJsonFromTemplate(String(templateName), TEMPLATES[templateName], params, timeoutMs);
  }

  nextTrackCode() {
    if (!this.trackCodeGenerator) {
      this.trackCodeGenerator = createDirectTrackCodeGenerator(this.account?.dtUserId ?? this.host);
    }
    return this.trackCodeGenerator();
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
    dumpDirectDebugFrame(String(templateName), request);
    await this.write(request);
  }

  async callCommonRestJson(label: string, apiName: string, query: string, timeoutMs = this.runtime.ioTimeoutMs) {
    const request = buildCommonRestRequestFrame({
      template: TEMPLATES.getPrivateNumber,
      session: this.sessionId,
      route: this.route,
      status: 0x0102,
      apiName,
      query
    });

    this.clearJsonQueue();
    this.beginJsonCapture(timeoutMs);
    await this.write(request);
    return this.waitForJsonPayload(timeoutMs, `${label} JSON response`, (payload) => {
      const expected = isExpectedCommonRestJsonPayload(apiName, payload);
      return (
        expected &&
        (matchesExpectedTrackCode(payload, extractQueryParam(query, "TrackCode")) ||
          hasStrongExpectedCommonRestShape(apiName, payload) ||
          isActivationCommonRestResult(apiName, payload))
      );
    });
  }

  async callConfiguredActivationTemplate(
    settingKey: DirectActivationTemplateSettingKey | DirectActivationTemplateSettingKey[],
    label: string,
    deviceId: string,
    extraParams: DirectTemplateParams,
    proofFallbackQuery?: string
  ) {
    const configured = await getConfiguredDirectTemplateFromKeys(settingKey);
    const template = configured?.template ?? null;
    if (!template) {
      throw new AppError(
        `Direct ${label} requires native activation template ${formatDirectTemplateKeys(settingKey)}; refusing to use the legacy CommonRest fallback.`,
        503,
        503
      );
    }
    const preserveCapturedEnvelope = isPreserveCapturedEnvelope(extraParams);
    const account = { dtUserId: "100000000000000", token: "", deviceId };
    let params = expandTemplateParams(
      buildConfiguredActivationParamSet(label, template.params ?? {}, extraParams),
      account,
      this.runtime
    );
    let effectiveDeviceId = normalizeTemplateString(params.deviceId) ?? deviceId;
    const templateBuffer = Buffer.from(template.hex.replace(/\s+/g, ""), "hex");
    const preserveRawPayload =
      preserveCapturedEnvelope &&
      label.toLowerCase().includes("activateemail") &&
      templateQueryParam(templateBuffer, "confirmCode") === stringifyPrimitive(params.confirmCode);

    // 濠碘€冲€归悘澶嬬▔瀹ュ棗濮悺鎺戝暱鐢偊宕犻崨鏉戞闁衡偓閸撗勭暠闁哄鈧弶顐介柨娑樼墕瀹撳棙绋夊鍡樞﹂梺钘夌墕椤曨噣寮婢跺嫰骞嬪畡鐗堝闁硅埖鎸哥€垫﹢寮崜浣圭暠闁绘鎳撻悾鐐殽瀹€鍐闁活喕绀佹禒娑㈡煂瀹ュ棙鏉归柨娑橆檧缁辨繃绋夐弮鈧崹婊勭椤戣法鐐婇柛蹇嬪劙缁繝宕㈤悢濂夋綏闁?query闁?    // 闁告帗鐟﹂崹婊勭椤掆偓缁烩偓濡炪倛顔婃繛鍥偨閵婏妇姊鹃柡鍫濐槺缁剝娼婚崶褍鐏╅梻鍕╁€楅悧顒勫锤韫囨洘鐣遍柛妯煎枎椤劖锛愬┑鍡╂▎闁告瑥鍊归弳鐔兼晬瀹€鍕闁哄倿顣︾换姘舵偩濞嗘垶鍩傞悗鍦仧濞堟垿鏌囬缁㈠敻闁烩晝顭堥崣褔宕ｉ崒娑欐濞寸姰鍎遍崢鎴犳媼?patch 闁哄洦瀵у畷鍙夌▔閻戞ɑ鐓€閻犳劧绠戣ぐ?
    if (!preserveRawPayload && proofFallbackQuery) {
      const fullExtraParams = buildActivationTemplateParams(proofFallbackQuery);
      params = expandTemplateParams(
        buildConfiguredActivationParamSet(label, template.params ?? {}, fullExtraParams),
        account,
        this.runtime
      );
      effectiveDeviceId = normalizeTemplateString(params.deviceId) ?? deviceId;
    }

    const frame = buildTemplateSendFrame({
      template: templateBuffer,
      session: this.sessionId,
      route: this.route,
      status: 0x0102,
      preserveRawPayload,
      params: {
        ...routeQueryParams(this.route),
        ...params,
        ...(preserveCapturedEnvelope && preserveRawPayload
          ? {}
          : {
              deviceId: effectiveDeviceId,
              deviceID: normalizeTemplateString(params.deviceID) ?? effectiveDeviceId
            }),
        appVersion: params.appVersion ?? this.runtime.appVersion,
        apkCertificateSign: params.apkCertificateSign ?? this.runtime.apkCertificateSign
      }
    });

    this.clearJsonQueue();
    this.beginJsonCapture(this.runtime.ioTimeoutMs);
    dumpDirectDebugFrame(label, frame);
    await this.write(frame);
    return this.waitForJsonPayload(this.runtime.ioTimeoutMs, `${label} native activation response`, (payload) => {
      return isExpectedActivationPayload(label, payload);
    });
  }

  async callConfiguredRegisterEmailTemplate(
    label: string,
    deviceId: string,
    extraParams: DirectTemplateParams,
    settingKey: DirectActivationTemplateSettingKey | DirectActivationTemplateSettingKey[] = "dt_direct_template_register_email"
  ) {
    const configured = await getConfiguredDirectTemplateFromKeys(settingKey);
    const template = configured?.template ?? null;
    if (!template) {
      throw new AppError(
        `Direct registerEmail requires native activation template ${formatDirectTemplateKeys(settingKey)}.`,
        503,
        503
      );
    }
    const preserveCapturedEnvelope = isPreserveCapturedEnvelope(extraParams);
    const account = { dtUserId: "100000000000000", token: "", deviceId };
    const params = expandTemplateParams(
      buildConfiguredActivationParamSet(label, template.params ?? {}, extraParams),
      account,
      this.runtime
    );
    const effectiveDeviceId = normalizeTemplateString(params.deviceId) ?? deviceId;
    const frame = buildTemplateSendFrame({
      template: Buffer.from(template.hex.replace(/\s+/g, ""), "hex"),
      session: this.sessionId,
      route: this.route,
      status: 0x0102,
      preserveRawPayload: false,
      params: {
        ...routeQueryParams(this.route),
        ...params,
        deviceId: effectiveDeviceId,
        deviceID: normalizeTemplateString(params.deviceID) ?? effectiveDeviceId,
        appVersion: params.appVersion ?? this.runtime.appVersion,
        apkCertificateSign: params.apkCertificateSign ?? this.runtime.apkCertificateSign
      }
    });

    this.clearJsonQueue();
    this.beginJsonCapture(this.runtime.ioTimeoutMs);
    this.queue = [];
    dumpDirectDebugFrame(label, frame);
    await this.write(frame);
    return this.waitForJsonPayload(this.runtime.ioTimeoutMs, `${label} native activation response`, (payload) => {
      return isExpectedActivationPayload(label, payload);
    });
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

  getBootstrapPayloads() {
    return [...this.bootstrapPayloads];
  }

  async callJsonFromTemplate(
    label: string,
    template: Buffer,
    params: DirectTemplateParams,
    timeoutMs = this.runtime.ioTimeoutMs
  ) {
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

    dumpDirectDebugFrame(label, request);
    this.clearJsonQueue();
    this.beginJsonCapture(timeoutMs);
    await this.write(request);
    return this.waitForJsonPayload(timeoutMs, `${label} JSON response`, (payload) => {
      const expected = isExpectedTemplateJsonPayload(label, payload);
      return expected && (matchesExpectedTrackCode(payload, stringifyPrimitive(params.trackCode ?? params.TrackCode)) || hasStrongExpectedTemplateShape(label, payload));
    });
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
        const candidatePush = frameToDirectPush(frame);
        if (candidatePush.sms) {
          await onFrame?.(candidatePush, this.host);
          pushes.push(candidatePush);
          await onPush?.(candidatePush);
          continue;
        }
        const nonSmsFrame = frame.status === 0x0103 ? candidatePush : frameToDirectFrameSummary(frame);
        await onFrame?.(nonSmsFrame, this.host);
        nonSmsPushFrameCount += 1;
        if (this.shouldLogSkippedNonSmsFrame()) {
          logger.info("Direct push frame skipped because it did not contain an SMS payload", {
            host: this.host,
            status: nonSmsFrame.status,
            bodyLength: nonSmsFrame.bodyLength,
            hasJsonPayload: Boolean(nonSmsFrame.jsonPayload),
            jsonPayload: summarizeJsonPayload(nonSmsFrame.jsonPayload)
          });
        }
        if (nonSmsPushFrameCount >= DIRECT_PUSH_NON_SMS_FRAME_BATCH_LIMIT) {
          await delay(DIRECT_PUSH_NON_SMS_FRAME_PAUSE_MS);
          return pushes;
        }
        await yieldToEventLoop();
      } catch (error) {
        if (isSocketClosedError(error)) {
          throw error;
        }
        if (error instanceof AppError && error.statusCode === 504) {
          break;
        }
        throw error;
      }
    }

    return pushes;
  }

  async close() {
    this.closed = true;
    this.stopSocketKeepalive();
    if (this.idleSocketPauseTimer) {
      clearTimeout(this.idleSocketPauseTimer);
      this.idleSocketPauseTimer = null;
    }
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }

  isOpen() {
    return Boolean(this.socket && !this.closed && !this.socket.destroyed && this.socket.readable && this.socket.writable);
  }

  getTrace() {
    return [...this.trace];
  }

  private async connectSocket(host: string, port: number, timeoutMs: number) {
    const useTls = port === 465 ? true : this.runtime.useTls;
    if (this.runtime.proxyUrl) {
      return connectSocketViaHttpProxy({
        proxyUrl: this.runtime.proxyUrl,
        host,
        port,
        useTls,
        timeoutMs
      });
    }

    const socket = useTls
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
      this.stopSocketKeepalive();
      this.failWaiters(error instanceof Error ? error : new Error(String(error)));
    });
    this.socket.on("end", () => {
      this.closed = true;
      this.stopSocketKeepalive();
      this.socket?.destroy();
      this.failWaiters(
        new Error(
          `Direct gateway socket ended after ${Math.max(0, Date.now() - this.socketConnectedAt)}ms (keepaliveWrites=${this.keepaliveWriteCount})`
        )
      );
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.stopSocketKeepalive();
      this.failWaiters(
        new Error(
          `Direct gateway socket closed after ${Math.max(0, Date.now() - this.socketConnectedAt)}ms (keepaliveWrites=${this.keepaliveWriteCount})`
        )
      );
    });
  }

  private consume(chunk: Buffer) {
    if (chunk.length > 0) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
    while (this.buffer[0] === 0xff) {
      this.buffer = this.buffer.subarray(1);
    }
    let processedFrames = 0;

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
      const shouldExtractJsonPayload = parsed.type === 0x8107 && parsed.status === 0x0102 && (this.jsonResolvers.length > 0 || Date.now() <= this.jsonCaptureUntil);
      const jsonPayload = shouldExtractJsonPayload ? extractJsonPayload(parsed.raw) : null;
      const shouldQueueRawFrame =
        parsed.type !== 0x8107 ||
        parsed.status === 0x0101 ||
        parsed.status === 0x0103 ||
        this.resolvers.length > 0;
      const shouldTraceFrame = shouldQueueRawFrame || Boolean(jsonPayload) || Boolean(process.env.DT_DIRECT_DEBUG_DUMP_DIR);
      if (!shouldTraceFrame) {
        this.pauseIdleSocketAfterDroppedFrame(parsed);
        processedFrames += 1;
        if (this.shouldYieldBufferedConsume(processedFrames)) {
          return;
        }
        continue;
      }

      if (process.env.DT_DIRECT_DEBUG_DUMP_DIR) {
        console.log(`[Socket Read] Length: ${parsed.raw.length}, Type: 0x${parsed.type.toString(16)}, Status: ${parsed.status !== undefined ? `0x${parsed.status.toString(16)}` : "undefined"}, Hex: ${parsed.raw.toString("hex")}`);
        if (jsonPayload) {
          console.log(`[Socket Read JSON]:`, JSON.stringify(jsonPayload));
        }
      }

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
        const offlineMessageIndexPush = parsed.type === 0x8107 && parsed.status === 0x0103
          ? isOfflineMessageIndexPush(parsed.raw) || isOfflineMessageIndexPush(parsed.body)
          : false;
        if (parsed.type === 0x8107 && parsed.status === 0x0103) {
          void this.acknowledgePushFrame(parsed, Boolean(smsPush) || offlineMessageIndexPush).catch((error) => {
          logger.warn("Direct push ACK failed", {
            host: this.host,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      if (shouldQueueRawFrame) {
        this.queue.push(frame);
        this.flushWaiters();
      }
      processedFrames += 1;
      if (this.shouldYieldBufferedConsume(processedFrames)) {
        return;
      }
    }
  }

  private shouldYieldBufferedConsume(processedFrames: number) {
    if (processedFrames < DIRECT_SOCKET_FRAME_BUDGET_PER_TICK || this.buffer.length < 6) {
      return false;
    }
    this.scheduleBufferedConsume();
    return true;
  }

  private scheduleBufferedConsume() {
    if (this.bufferedConsumeScheduled || this.closed) {
      return;
    }
    this.bufferedConsumeScheduled = true;
    this.socket?.pause();
    setImmediate(() => {
      this.bufferedConsumeScheduled = false;
      if (this.closed) {
        return;
      }
      this.socket?.resume();
      if (this.buffer.length >= 6) {
        this.consume(Buffer.alloc(0));
      }
    });
  }
  private shouldLogSkippedNonSmsFrame() {
    if (this.skippedNonSmsLogCount >= 5) {
      return false;
    }
    this.skippedNonSmsLogCount += 1;
    return true;
  }
  private async write(frame: Buffer) {
    const socket = this.socket;
    if (!socket || this.closed || socket.destroyed || !socket.writable) {
      throw new Error("Direct gateway socket is not writable");
    }
    if (process.env.DT_DIRECT_DEBUG_DUMP_DIR) {
      console.log(`[Socket Write] Length: ${frame.length}, Hex: ${frame.toString("hex")}`);
    }
    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private startPairedKeepalive() {
    this.stopSocketKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.keepaliveWriteInFlight || this.closed) {
        return;
      }
      this.keepaliveWriteInFlight = true;
      void this.write(buildDirectSessionKeepaliveFrame(this.sessionId))
        .then(() => {
          this.keepaliveWriteCount += 1;
        })
        .catch((error) => {
          if (!this.closed) {
            logger.warn("Direct push keepalive write failed", {
              host: this.host,
              error: error instanceof Error ? error.message : String(error)
            });
            this.socket?.destroy();
          }
        })
        .finally(() => {
          this.keepaliveWriteInFlight = false;
        });
    }, DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref?.();
  }

  private async startSocketKeepalive() {
    this.stopSocketKeepalive();
    await this.write(buildDirectSessionKeepaliveFrame(this.sessionId));
    this.keepaliveWriteCount += 1;
    this.keepaliveTimer = setInterval(() => {
      if (this.keepaliveWriteInFlight || this.closed) {
        return;
      }
      this.keepaliveWriteInFlight = true;
      void this.write(buildDirectSessionKeepaliveFrame(this.sessionId))
        .then(() => {
          this.keepaliveWriteCount += 1;
        })
        .catch((error) => {
          if (!this.closed) {
            logger.warn("Direct gateway keepalive write failed", {
              host: this.host,
              error: error instanceof Error ? error.message : String(error)
            });
            this.socket?.destroy();
          }
        })
        .finally(() => {
          this.keepaliveWriteInFlight = false;
        });
    }, directSessionKeepaliveIntervalMs(this.account));
    this.keepaliveTimer.unref?.();
  }

  private stopSocketKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.keepaliveWriteInFlight = false;
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
    const packet = buildLoginInitPacket({
      session: this.sessionId,
      route: this.route,
      runtime: this.runtime,
      account,
      loginTrackCode: this.nextTrackCode(),
      configTrackCode: this.nextTrackCode()
    });
    this.clearJsonQueue();
    this.beginJsonCapture(3_000);
    await this.write(packet);
    await this.drainBootstrapFrames(3_000);
    this.bootstrapPayloads = [...this.jsonQueue];
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
      const queuedRaw = this.queue.shift();
      if (queuedRaw) {
        const parsed = parseFrame(queuedRaw);
        if (predicate(parsed)) {
          return parsed;
        }
        await yieldToEventLoop();
        continue;
      }

      const remaining = Math.max(250, deadline - Date.now());
      const raw = await this.nextRawFrame(remaining, label);
      const parsed = parseFrame(raw);
      if (predicate(parsed)) {
        return parsed;
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

  private async waitForJsonPayload(timeoutMs: number, label: string, predicate: (payload: ApiResult) => boolean = () => true) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const queuedIndex = this.jsonQueue.findIndex((payload) => predicate(payload));
      if (queuedIndex >= 0) {
        const [payload] = this.jsonQueue.splice(queuedIndex, 1);
        if (payload) {
          return payload;
        }
      }

      if (this.jsonQueue.length > 0) {
        const skipped = this.jsonQueue.shift();
        logger.debug("Skipped unrelated direct JSON payload while waiting for typed response", {
          host: this.host,
          label,
          payload: summarizeJsonPayload(skipped)
        });
        continue;
      }

      const remaining = Math.max(250, deadline - Date.now());
      const payload = await this.nextJsonPayload(remaining, label);
      if (predicate(payload)) {
        return payload;
      }
      logger.debug("Skipped unrelated direct JSON payload while waiting for typed response", {
        host: this.host,
        label,
        payload: summarizeJsonPayload(payload)
      });
    }

    throw new AppError(`Timed out waiting for ${label}`, 504, 504);
  }

  private nextJsonPayload(timeoutMs: number, label: string) {
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


  private pauseIdleSocketAfterDroppedFrame(parsed: ParsedFrame) {
    if (parsed.type !== 0x8107 || parsed.status === 0x0101 || parsed.status === 0x0103 || this.resolvers.length > 0 || this.jsonResolvers.length > 0) {
      this.idleDroppedNonSmsFrameCount = 0;
      return;
    }
    this.idleDroppedNonSmsFrameCount += 1;
    if (this.idleDroppedNonSmsFrameCount < DIRECT_IDLE_NON_SMS_FRAME_PAUSE_BATCH || this.idleSocketPaused || !this.socket || this.socket.destroyed) {
      return;
    }
    this.idleDroppedNonSmsFrameCount = 0;
    this.idleSocketPaused = true;
    this.socket.pause();
    this.idleSocketPauseTimer = setTimeout(() => {
      this.idleSocketPaused = false;
      this.idleSocketPauseTimer = null;
      this.socket?.resume();
    }, DIRECT_IDLE_NON_SMS_FRAME_PAUSE_MS);
    this.idleSocketPauseTimer.unref?.();
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

  private beginJsonCapture(timeoutMs: number) {
    this.jsonCaptureUntil = Math.max(this.jsonCaptureUntil, Date.now() + timeoutMs);
  }

  private clearJsonQueue() {
    this.jsonQueue = [];
    this.jsonCaptureUntil = 0;
  }
}

function isExpectedTemplateJsonPayload(label: string, payload: ApiResult) {
  const normalized = label.toLowerCase();
  if (normalized.includes("queryrtcservers")) {
    return isRtcServerListPayload(payload);
  }
  if (normalized.includes("getbalance")) {
    return isBalancePayload(payload);
  }
  if (normalized.includes("getusersetting")) {
    return hasAnyOwnKey(payload, ["userSettingVerId", "userSettingContent", "removeAdRemainingTime"]);
  }
  if (normalized.includes("getprivatenumber")) {
    return hasPhoneListPayload(payload);
  }
  if (normalized.includes("getwebofflinemessage")) {
    return hasWebOfflineMessagePayload(payload);
  }
  return true;
}

export function isExpectedTemplateJsonPayloadForTest(label: string, payload: ApiResult) {
  return isExpectedTemplateJsonPayload(label, payload);
}

function isExpectedCommonRestJsonPayload(apiName: string, payload: ApiResult) {
  const normalized = apiName.toLowerCase();
  if (!normalized.includes("billing/user/getbalance") && isBalancePayload(payload)) {
    return false;
  }
  if (normalized.includes("point/summary")) {
    return hasNestedOwnKey(payload, "uid") || hasNestedOwnKey(payload, "validPoint") || hasNestedOwnKey(payload, "userGrade") || hasErrCode(payload, 7001);
  }
  if (normalized.includes("point/gradeinfo")) {
    return hasNestedOwnKey(payload, "validPoint") || hasNestedOwnKey(payload, "userGrade") || hasErrCode(payload, 7001);
  }
  if (normalized.includes("billing/product/v3/get")) {
    return (
      hasNestedOwnKey(payload, "products") ||
      hasNestedOwnKey(payload, "paymentTypes") ||
      hasNestedOwnKey(payload, "paypalInfo") ||
      hasNestedOwnKey(payload, "braintreeInfo") ||
      hasErrCode(payload, 7001)
    );
  }
  if (normalized.includes("pstn/share/getprivatenumber")) {
    return hasPhoneListPayload(payload) || hasErrCode(payload, 7001);
  }
  if (normalized.includes("getwebofflinemessage") || normalized.includes("getuserofflinemsg")) {
    return hasWebOfflineMessagePayload(payload) || hasAnyOwnKey(payload, ["Result", "result", "ErrCode", "errCode", "errorCode"]);
  }
  if (normalized.includes("checkactivated") || normalized.includes("checkuseractivate")) {
    return hasActivatedUserPayload(payload) || hasAnyOwnKey(payload, ["Result", "result", "ErrCode", "errCode", "errorCode"]);
  }
  return true;
}

function isExpectedActivationPayload(label: string, payload: ApiResult) {
  const normalized = label.toLowerCase();
  if (normalized.includes("activateemail")) {
    return (
      isActivationLoginSuccessPayload(payload) ||
      hasAnyOwnKey(payload, ["dtUserId", "dt_user_id", "userId", "userID", "UserId", "uid", "UserID", "token", "loginToken", "dtToken", "Token"]) ||
      hasAnyOwnKey(payload, ["Result", "result", "ErrCode", "errCode", "errorCode"])
    );
  }
  return hasAnyOwnKey(payload, ["Result", "result", "ErrCode", "errCode", "errorCode", "returnedAccessCode", "confirmCode", "accessCode"]);
}

function findLastActivationPayload(trace: DirectProbeFrameTrace[], label: string) {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const payload = trace[index]?.jsonPayload;
    if (payload && isExpectedActivationPayload(label, payload)) {
      return payload;
    }
  }
  return null;
}

function findLastCommonRestPayload(trace: DirectProbeFrameTrace[], apiName: string) {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const payload = trace[index]?.jsonPayload;
    if (payload && isExpectedCommonRestJsonPayload(apiName, payload)) {
      return payload;
    }
  }
  return null;
}

function isActivationLoginSuccessPayload(payload: ApiResult) {
  const result = payload.Result ?? payload.result;
  return Number(result) === 1 && Boolean(pickString(payload, ["Token", "token", "loginToken", "dtToken"])) && Boolean(pickString(payload, ["UserId", "userId", "UserID", "dtUserId", "uid"]));
}

function hasStrongExpectedCommonRestShape(apiName: string, payload: ApiResult) {
  const normalized = apiName.toLowerCase();
  if (normalized.includes("billing/user/getbalance")) {
    return isBalancePayload(payload);
  }
  if (normalized.includes("gwebsvr/infobus") || normalized.includes("glb/userpropertites") || normalized.includes("glb/userproperties")) {
    return hasUserProfileOrPropertyPayload(payload);
  }
  if (normalized.includes("point/summary") || normalized.includes("point/gradeinfo")) {
    return hasNestedOwnKey(payload, "uid") || hasNestedOwnKey(payload, "validPoint") || hasNestedOwnKey(payload, "userGrade");
  }
  if (normalized.includes("billing/product/v3/get")) {
    return hasNestedOwnKey(payload, "products") || hasNestedOwnKey(payload, "paymentTypes") || hasNestedOwnKey(payload, "paypalInfo");
  }
  if (normalized.includes("pstn/share/getprivatenumber")) {
    return hasPhoneListPayload(payload);
  }
  if (normalized.includes("getwebofflinemessage") || normalized.includes("getuserofflinemsg")) {
    return hasWebOfflineMessagePayload(payload);
  }
  if (normalized.includes("checkactivated") || normalized.includes("checkuseractivate")) {
    return hasActivatedUserPayload(payload);
  }
  return false;
}

function directSessionKeepaliveIntervalMs(account: DirectSessionAccount | undefined) {
  return account?.appVariant === "dingdong"
    ? DINGDONG_SESSION_KEEPALIVE_INTERVAL_MS
    : DIRECT_SESSION_KEEPALIVE_INTERVAL_MS;
}

function hasWebOfflineMessagePayload(payload: ApiResult) {
  return (
    hasNestedOwnKey(payload, "aOfflineMessagse") ||
    hasNestedOwnKey(payload, "aOfflineMessages") ||
    hasNestedOwnKey(payload, "offlineMessages") ||
    hasNestedOwnKey(payload, "Message")
  );
}

export function normalizeDirectWebOfflineMessages(payload: unknown, appVariant?: "dingtone" | "dingdong"): DirectWebOfflineMessage[] {
  const rows: DirectWebOfflineMessage[] = [];
  const seen = new Set<string>();
  for (const record of collectDirectWebOfflineRecords(payload)) {
    const title = pickString(record, ["msgTitle", "title"]);
    const rawBody = pickString(record, ["msgContent", "content", "message", "body"]);
    const messageType = pickNumber(record, ["msgType", "type"]) ?? null;
    const originalSenderId = pickString(record, ["msgSenderID", "msgSenderId", "senderId", "sender", "from"]) ?? null;
    const teamName = resolveDirectWebOfflineTeamName(messageType, title, originalSenderId, appVariant);
    if (!teamName) {
      continue;
    }
    const commonEvent = messageType === 3300 ? parseDirectSecretaryCommonEvent(rawBody) : null;
    const body = commonEvent?.content ?? rawBody;
    const content = title && body && title !== body ? `${title}\n${body}` : title ?? body;
    if (!content) {
      continue;
    }
    const msgId = pickString(record, ["msgId", "messageId", "id"]) ?? null;
    const timestamp = pickNumber(record, ["msgTimeStamp", "timestamp", "time", "createdAt"]) ?? null;
    const meta = normalizeDirectWebOfflineMeta(record.msgMeta ?? record.meta ?? commonEvent?.args);
    const dedupeKey = msgId ?? `${teamName}|${timestamp ?? ""}|${content}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    rows.push({
      conversationType: 4,
      conversationId: "10000",
      type: messageType,
      senderId: teamName,
      msgId,
      content,
      timestamp,
      isRead: 0,
      data1: teamName,
      data2: meta,
      data3: "direct-web-offline"
    });
  }
  return rows;
}

function resolveDirectWebOfflineTeamName(
  messageType: number | null,
  title: string | null | undefined,
  senderId: string | null | undefined,
  appVariant?: "dingtone" | "dingdong"
) {
  if (messageType === 3300) {
    return appVariant === "dingdong" ? "叮咚团队" : "说道团队";
  }
  for (const value of [title, senderId]) {
    if (/^(?:叮咚团队|dingtone\s+team|dingdong\s+team)$/i.test(value ?? "")) {
      return "叮咚团队";
    }
    if (/^(?:说道团队|talku\s+team|talkyou\s+team)$/i.test(value ?? "")) {
      return "说道团队";
    }
  }
  return null;
}

function parseDirectSecretaryCommonEvent(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      content: pickString(parsed, ["content", "message", "body"]),
      args: parsed.args
    };
  } catch {
    return null;
  }
}

export function buildGetWebOfflineMessageQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  trackCode: string
) {
  return [
    queryPair("deviceId", accountDeviceId(account)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token),
    queryPair("TrackCode", trackCode),
    queryPair("bDevice", 1)
  ].join("&");
}

export function buildGetWebOfflineMessageFrameForTest(params: DirectTemplateParams) {
  return buildRequestFrame({
    template: TEMPLATES.getWebOfflineMessage,
    session: Buffer.alloc(4),
    route: Buffer.from("d33d000300502788", "hex"),
    status: 0x0102,
    params
  });
}

function collectDirectWebOfflineRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectDirectWebOfflineRecords(item, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }
  if (hasAnyOwnKey(value, ["msgContent", "msgId", "msgSenderID", "msgTimeStamp", "msgTitle"])) {
    return [value];
  }

  const rows: Record<string, unknown>[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "aofflinemessagse" ||
      normalizedKey === "aofflinemessages" ||
      normalizedKey === "offlinemessages" ||
      normalizedKey === "message" ||
      normalizedKey === "messages" ||
      normalizedKey === "list" ||
      normalizedKey === "data" ||
      normalizedKey === "result" ||
      normalizedKey === "payload" ||
      normalizedKey === "response"
    ) {
      rows.push(...collectDirectWebOfflineRecords(nested, depth + 1));
    }
  }
  return rows;
}

function normalizeDirectWebOfflineMeta(value: unknown) {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function hasStrongExpectedTemplateShape(label: string, payload: ApiResult) {
  const normalized = label.toLowerCase();
  if (normalized.includes("queryrtcservers")) {
    return isRtcServerListPayload(payload);
  }
  if (normalized.includes("getbalance")) {
    return isBalancePayload(payload);
  }
  if (normalized.includes("getusersetting")) {
    return hasAnyOwnKey(payload, ["userSettingVerId", "userSettingContent", "removeAdRemainingTime"]);
  }
  if (normalized.includes("getprivatenumber")) {
    return hasPhoneListPayload(payload);
  }
  if (normalized.includes("getwebofflinemessage")) {
    return hasWebOfflineMessagePayload(payload);
  }
  if (normalized.includes("infobus") || normalized.includes("userpropertites") || normalized.includes("userproperties")) {
    return hasUserProfileOrPropertyPayload(payload);
  }
  return false;
}

function isRtcServerListPayload(payload: ApiResult) {
  const apiName = stringifyPrimitive(payload.api_name ?? payload.apiName)?.toLowerCase() ?? "";
  return (
    apiName === "query_rtc_servers_ex" ||
    apiName === "queryrtcserversex" ||
    hasNestedOwnKey(payload, "server_list") ||
    hasNestedOwnKey(payload, "rtcServerList")
  );
}

function isActivationCommonRestResult(apiName: string, payload: ApiResult) {
  const normalized = apiName.toLowerCase();
  if (
    !normalized.includes("registercommon") &&
    !normalized.includes("activatecommon") &&
    !normalized.includes("activationcommon") &&
    !normalized.includes("checkactivated")
  ) {
    return false;
  }
  return hasAnyOwnKey(payload, ["Result", "result", "ErrCode", "errCode", "errorCode"]);
}

function matchesExpectedTrackCode(payload: ApiResult, expectedTrackCode: string | null | undefined) {
  if (!expectedTrackCode) {
    return true;
  }
  const actual = stringifyPrimitive(payload.TrackCode ?? payload.trackCode);
  return !actual || actual === expectedTrackCode;
}

function extractQueryParam(query: string, key: string) {
  const params = new URLSearchParams(query.startsWith("&") ? query.slice(1) : query);
  return params.get(key) ?? params.get(key.toLowerCase()) ?? undefined;
}

function isBalancePayload(payload: ApiResult) {
  return hasAnyOwnKey(payload, [
    "primaryBalance",
    "primary_balance",
    "balance",
    "creditExchangeRatio",
    "giftableBalance",
    "subscriptionBalance",
    "creditBonuses",
    "callPlans"
  ]);
}

function hasPositiveBalancePayload(payload: unknown) {
  return pickPositiveNumberFromRecords(collectNestedRecords(payload), [
    "primaryBalance",
    "primary_balance",
    "balance",
    "balanceAmount",
    "balance_amount",
    "availableBalance",
    "available_balance",
    "walletBalance",
    "wallet_balance",
    "coinBalance",
    "coin_balance",
    "creditBalance",
    "credit_balance"
  ]) !== undefined;
}

function hasPhoneListPayload(payload: ApiResult) {
  return hasAnyOwnKey(payload, ["numberExList", "numberExlist", "numberList", "phoneNumbers", "items", "list"]) || hasNestedOwnKey(payload, "phoneNumber");
}

function hasActivatedUserPayload(payload: ApiResult | undefined) {
  if (!payload) {
    return false;
  }
  return (
    hasAnyOwnKey(payload, ["activatedUserList", "activatedUsers", "userList", "users"]) ||
    hasNestedOwnKey(payload, "activatedUserList") ||
    hasNestedOwnKey(payload, "hasPassword") ||
    hasNestedOwnKey(payload, "isPrivateNumber") ||
    (hasNestedOwnKey(payload, "userId") && hasNestedOwnKey(payload, "dingtoneId"))
  );
}

function hasActivationDefinitiveEmptyPayload(payload: ApiResult | undefined) {
  if (!payload) {
    return false;
  }
  const result = payload.Result ?? payload.result;
  const errCode = payload.ErrCode ?? payload.errCode ?? payload.errorCode;
  return Number(result) === 0 || (errCode !== undefined && Number(errCode) === 0);
}

function hasUserProfileOrPropertyPayload(payload: ApiResult) {
  return (
    hasNestedOwnKey(payload, "DingtoneId") ||
    hasNestedOwnKey(payload, "dingtoneId") ||
    hasNestedOwnKey(payload, "publicUserId") ||
    hasNestedOwnKey(payload, "PhoneNumberCount") ||
    hasNestedOwnKey(payload, "Storage") ||
    hasNestedOwnKey(payload, "IpISOCountryCode") ||
    hasNestedOwnKey(payload, "userProperties") ||
    hasNestedOwnKey(payload, "userProperty") ||
    hasNestedOwnKey(payload, "properties")
  );
}

function hasErrCode(payload: ApiResult, expected: number) {
  const errCode = payload.ErrCode ?? payload.errCode ?? payload.errorCode;
  return Number(errCode) === expected;
}

function hasAnyOwnKey(payload: ApiResult, keys: string[]) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
}

function hasNestedOwnKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasNestedOwnKey(item, key));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return true;
  }
  return Object.values(value).some((item) => hasNestedOwnKey(item, key));
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

  const templateCompressedLength = templateBody.readUInt32BE(zlibOffset - 4);
  const suffix = templateBody.subarray(zlibOffset + templateCompressedLength);
  const templateQuery = zlib.inflateSync(templateBody.subarray(zlibOffset)).toString("utf8");
  const nextQuery = patchQuery(templateQuery, input.params);
  const compressed = zlib.deflateSync(Buffer.from(nextQuery, "utf8"));

  let prefix = patchEmbeddedCommonRestQueryLength(
    Buffer.from(templateBody.subarray(0, zlibOffset - 8)),
    Buffer.byteLength(templateQuery, "utf8"),
    Buffer.byteLength(nextQuery, "utf8")
  );

  const apiName = findTrailingLengthPrefixedAscii(prefix);
  if (apiName) {
    prefix = patchPrefixPayloadLength(prefix, apiName, templateCompressedLength, compressed.length);
    prefix = patchEmbeddedCommonRestPayloadLength(prefix, apiName, compressed.length);
  }

  const body = Buffer.concat([
    replaceRouteBytes(
      prefix,
      input.route
    ),
    u32be(Buffer.byteLength(nextQuery, "utf8")),
    u32be(compressed.length),
    compressed,
    suffix
  ]);

  return encodeFrame(input.session, input.status, body);
}

function patchPrefixPayloadLength(prefix: Buffer, apiName: string, oldCompressedLength: number, newCompressedLength: number) {
  if (apiName !== "registerCommon" && apiName !== "activateCommon") {
    return prefix;
  }
  const apiBytes = Buffer.from(apiName, "utf8");
  const apiIndex = prefix.indexOf(apiBytes);
  if (apiIndex < 8) {
    return prefix;
  }

  const apiLengthOffset = apiIndex - 4;
  if (prefix.readUInt32BE(apiLengthOffset) !== apiBytes.length) {
    return prefix;
  }

  let lengthOffset = -1;
  if (apiIndex >= 13 && prefix[apiIndex - 5] === 0x32 && prefix.readUInt32BE(apiIndex - 9) === 1) {
    lengthOffset = apiIndex - 13;
  } else if (apiIndex >= 12 && prefix.readUInt32BE(apiIndex - 8) === 0) {
    lengthOffset = apiIndex - 12;
  }

  if (lengthOffset >= 0) {
    const oldLength = prefix.readUInt32BE(lengthOffset);
    const newLength = oldLength + (newCompressedLength - oldCompressedLength);
    const patched = Buffer.from(prefix);
    patched.writeUInt32BE(newLength, lengthOffset);
    return patched;
  }

  return prefix;
}

function buildTemplateSendFrame(input: {
  template: Buffer;
  session: Buffer;
  route?: Buffer;
  status: number;
  preserveRawPayload?: boolean;
  params: DirectTemplateParams;
}) {
  if (input.preserveRawPayload) {
    const { body } = getDirectTemplateBody(input.template);
    return encodeFrame(input.session, input.status, replaceRouteBytes(body, input.route));
  }
  try {
    return buildRequestFrame(input);
  } catch {
    const { body } = getDirectTemplateBody(input.template);
    return encodeFrame(input.session, input.status, patchLengthPrefixedTemplateFields(replaceRouteBytes(body, input.route), input.params));
  }
}

function templateQueryParam(template: Buffer, key: string) {
  try {
    const { body } = getDirectTemplateBody(template);
    const zlibOffset = findZlibOffset(body);
    if (zlibOffset < 0) {
      return null;
    }
    const query = zlib.inflateSync(body.subarray(zlibOffset)).toString("utf8");
    return new URLSearchParams(query).get(key);
  } catch {
    return null;
  }
}

function buildConfiguredActivationParamSet(label: string, templateParams: DirectTemplateParams, extraParams: DirectTemplateParams) {
  const params = {
    ...templateParams,
    ...extraParams
  };
  const preserveCapturedEnvelope = params.__preserveCapturedEnvelope === true || params.__preserveCapturedEnvelope === "true";
  const preserveCapturedDeviceEnvelope =
    params.__preserveCapturedDeviceEnvelope === true || params.__preserveCapturedDeviceEnvelope === "true";
  delete params.__preserveCapturedEnvelope;
  delete params.__preserveCapturedDeviceEnvelope;
  if (preserveCapturedEnvelope || preserveCapturedDeviceEnvelope) {
    delete params.deviceId;
    delete params.deviceID;
    delete params.email;
    delete params.Email;
    delete params.clientInfo;
    if (preserveCapturedEnvelope) {
      delete params.json;
    }
    for (const key of Object.keys(params)) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.startsWith("clientinfo.") ||
        normalizedKey.startsWith("clientinfo_") ||
        (preserveCapturedEnvelope && (normalizedKey.startsWith("json.") || normalizedKey.startsWith("json_")))
      ) {
        delete params[key];
      }
    }
  }
  return params;
}

function dumpDirectDebugFrame(label: string, frame: Buffer) {
  const dir = process.env.DT_DIRECT_DEBUG_DUMP_DIR?.trim();
  if (!dir) {
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9_.-]+/gi, "_");
    fs.writeFileSync(`${dir}/${Date.now()}-${safeLabel}.bin`, frame);
  } catch {
    // Debug-only best effort.
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

function findTrailingLengthPrefixedAscii(prefix: Buffer) {
  for (let index = prefix.length - 1; index >= 4; index -= 1) {
    const lengthOffset = index - 4;
    const length = prefix.readUInt32BE(lengthOffset);
    if (length <= 0 || length > 128 || index + length > prefix.length) {
      continue;
    }
    const value = prefix.subarray(index, index + length).toString("utf8");
    if (/^[A-Za-z0-9_./-]+$/.test(value)) {
      return value;
    }
  }
  return null;
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
  account: { dtUserId: string; token: string; deviceId?: string | null; email?: string | null; appVariant?: "dingtone" | "dingdong" };
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
    appId: resolveDirectAccountAppId(input.account),
    apkCertificateSign: resolveDirectAccountApkCertificateSign(input.account, input.runtime.apkCertificateSign)
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
      appVersion: resolveDirectAppVersion(input.account, input.runtime),
      apkCertificateSign: resolveDirectApiApkCertificateSign(input.account, input.runtime.apkCertificateSign)
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
  const finalBody = Buffer.concat([
    body.subarray(0, queryLengthOffset),
    u32be(nextQueryBytes.length),
    nextQueryBytes,
    body.subarray(queryEnd)
  ]);

  // Patch: update the sub-payload length prefix at offset 85
  const subPayloadLength = finalBody.length - 89;
  finalBody.writeUInt32BE(subPayloadLength, 85);

  return finalBody;
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

  const appendKeys = parseAppendQueryKeys(params.__appendQueryKeys);
  const seenKeys = new Set<string>();
  const output: string[] = [];
  for (const entry of entries) {
    if (!entry.includes("=")) {
      output.push(entry);
      continue;
    }
    const [key = "", ...rest] = entry.split("=");
    const value = rest.join("=");
    const normalizedKey = key.toLowerCase();
    seenKeys.add(normalizedKey);
    const replacement = replacements.get(normalizedKey);
    if (replacement === undefined) {
      output.push(`${key}=${patchNestedJsonQueryEntry(key, value, replacements)}`);
      continue;
    }
    output.push(`${key}=${encodeURIComponent(replacement)}`);
  }

  for (const key of appendKeys) {
    const normalizedKey = key.toLowerCase();
    if (seenKeys.has(normalizedKey)) {
      continue;
    }
    const replacement = replacements.get(normalizedKey);
    if (replacement !== undefined) {
      output.push(`${key}=${encodeURIComponent(replacement)}`);
    }
  }

  return output.join("&");
}

function parseAppendQueryKeys(value: unknown) {
  const raw = stringifyPrimitive(value);
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function patchNestedJsonQueryEntry(key: string, value: string, replacements: Map<string, string>) {
  const parsed = parseEncodedJsonObject(value);
  if (!parsed) {
    return value;
  }
  let changed = false;
  const normalizedKey = key.toLowerCase();
  for (const [replacementKey, replacementValue] of replacements.entries()) {
    const dotPrefix = `${normalizedKey}.`;
    const underscorePrefix = `${normalizedKey}_`;
    let childKey: string | null = null;
    if (replacementKey.startsWith(dotPrefix)) {
      childKey = replacementKey.slice(dotPrefix.length);
    } else if (replacementKey.startsWith(underscorePrefix)) {
      childKey = replacementKey.slice(underscorePrefix.length);
    }
    if (!childKey) {
      continue;
    }
    const existingKey = Object.keys(parsed).find((candidate) => candidate.toLowerCase() === childKey);
    parsed[existingKey ?? childKey] = coerceNestedJsonReplacement(parsed[existingKey ?? childKey], replacementValue);
    changed = true;
  }
  return changed ? encodeURIComponent(JSON.stringify(parsed)) : value;
}

function coerceNestedJsonReplacement(previous: unknown, value: string) {
  if (typeof previous === "number" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (typeof previous === "boolean" && /^(true|false)$/i.test(value)) {
    return value.toLowerCase() === "true";
  }
  return value;
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
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
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
      queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
      queryPair("userId", account.dtUserId),
      queryPair("token", account.token)
    );
  }

  const joined = query.join("&");
  return options.leadingAmpersand ? `&${joined}` : joined;
}

function buildGetNumberCountriesQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  trackCode: string
) {
  return [
    queryPair("deviceId", accountDeviceId(account)),
    queryPair("TrackCode", trackCode),
    queryPair("apiVersion", 2),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function buildGetBalanceQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  trackCode: string
) {
  const deviceId = accountDeviceId(account);
  return [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", trackCode),
    queryPair("clientVersion", runtime.appVersion),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function buildGetBalanceQueryAttempts(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  nextTrackCode: () => string
) {
  const deviceId = accountDeviceId(account);
  const appObserved = () => [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", nextTrackCode()),
    "",
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
  const appSigned = [
    queryPair("token", account.token),
    queryPair("deviceId", deviceId),
    queryPair("userId", account.dtUserId),
    queryPair("clientVersion", runtime.appVersion),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign))
  ].join("&");
  const tracked = () => buildGetBalanceQuery(account, runtime, nextTrackCode());
  return [
    appObserved(),
    tracked(),
    appSigned,
    `${appObserved()}&${queryPair("commandTag", 1)}`,
    `${tracked()}&${queryPair("commandTag", 1)}`,
    `${appSigned}&${queryPair("commandTag", 1)}`
  ];
}

function buildGetPrivateNumberListQueryAttempts(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  nextTrackCode: () => string
) {
  const base = () => buildGetPrivateNumberListQuery(account, runtime, nextTrackCode());
  const deviceId = accountDeviceId(account);
  const tokenFirst = [
    queryPair("token", account.token),
    queryPair("deviceId", deviceId),
    queryPair("userId", account.dtUserId),
    queryPair("clientVersion", runtime.appVersion),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign))
  ].join("&");
  const retry = () => `${base()}&${queryPair("commandTag", 1)}`;
  return [
    base(),
    tokenFirst,
    `${tokenFirst}&${queryPair("commandTag", 1)}`,
    retry(),
    retry(),
    retry(),
    `${base()}&${queryPair("requestFrom", 1)}&${queryPair("commandTag", 1)}`,
    `${base()}&${queryPair("from", 1)}&${queryPair("commandTag", 1)}`
  ];
}

function buildGetPrivateNumberListQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  trackCode: string
) {
  const deviceId = accountDeviceId(account);
  return [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", trackCode),
    queryPair("clientVersion", runtime.appVersion),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function buildGlbUserPropertiesQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
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
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function buildGwebInfoBusQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  trackCode: string
) {
  const deviceId = accountDeviceId(account);
  return [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", trackCode),
    "",
    queryPair("appId", resolveDirectGwebAppId(account)),
    queryPair("storeID", 2),
    queryPair("countryCode", 86),
    queryPair("clientVersion", runtime.appVersion),
    queryPair("isoCC", "CN"),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function buildDirectSessionClientInfoQuery(
  account: DirectSessionAccount,
  runtime: DirectRuntimeConfig,
  trackCode: string
) {
  const deviceId = accountDeviceId(account);
  const appVersion = resolveDirectAppVersion(account, runtime);
  const clientInfo = JSON.stringify({
    deviceOriginalId: "0000000000000000",
    advertisingId: "00000000-0000-0000-0000-000000000000",
    appVersion,
    timezone: "Asia/Shanghai",
    tzOffset: "GMT+08:00",
    simCC: "cn",
    mac: "02:00:00:00:00:00",
    imei: "000000000000000",
    mobileNum: "00000000000",
    wifiSSid: "AndroidWifi",
    language: "zh",
    serialNumber: "000000000000",
    mobileNetworkCarrier: {
      mcc: 460,
      mnc: 0,
      carrierNmae: "China Mobile GSM"
    },
    isoCountryCode: "CN",
    isSimulator: 0,
    rooted: 1,
    connectedV: 0,
    hasV: 0,
    appId: appIdForVariant(account.appVariant),
    deviceId,
    platform: "Android",
    manufacture: "OPPO",
    osVersion: "9",
    deviceModel: "PCRT00",
    clientTime: Date.now(),
    ipv4: "10.0.2.15"
  });
  return [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", trackCode),
    queryPair("appVersion", appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("clientInfo", clientInfo)
  ].join("&");
}

function resolveDirectGwebAppId(identity: string | DirectAccountIdentity) {
  return isTalkUIdentity(identity) ? "TU" : "DT";
}

function buildPointSummaryQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  trackCode: string,
  appId: string | number = resolvePointProductId(account.appVariant)
) {
  const deviceId = accountDeviceId(account);
  return [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", trackCode),
    queryPair("appId", appId),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function buildPointSummaryQueryAttempts(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  nextTrackCode: () => string
) {
  const pointAppId = resolvePointProductId(account.appVariant);
  const gameAppId = account.appVariant === "dingdong" ? 66 : 67;
  const webAppId = resolveDirectGwebAppId(account);
  return uniqueStrings([
    buildPointSummaryQuery(account, runtime, nextTrackCode(), pointAppId),
    buildPointSummaryQuery(account, runtime, nextTrackCode(), gameAppId),
    buildPointSummaryQuery(account, runtime, nextTrackCode(), webAppId),
    buildPointSummaryQuery(account, runtime, nextTrackCode(), appIdForVariant(account.appVariant))
  ]);
}

function buildPointGradeInfoQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  trackCode: string,
  uid: string
) {
  const deviceId = accountDeviceId(account);
  return [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", trackCode),
    queryPair("uid", uid),
    queryPair("appVersion", runtime.appVersion),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ].join("&");
}

function buildBillingProductsQuery(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  trackCode: string,
  options: { appId?: string; bid?: string; requireGP?: 0 | 1; includeClientInfo?: boolean } = {}
) {
  const deviceId = accountDeviceId(account);
  const appId = options.appId ?? appIdForVariant(account.appVariant);
  const bid = options.bid ?? appId;
  const parts = [
    queryPair("deviceId", deviceId),
    queryPair("TrackCode", trackCode),
    queryPair("appId", appId),
    queryPair("bid", bid),
    queryPair("storeType", 2),
    queryPair("productTypes", "1,120"),
    queryPair("isoCountryCode", "CN"),
    queryPair("appVersion", runtime.appVersion),
    queryPair("requireGP", options.requireGP ?? 1),
    ...(options.includeClientInfo ? [queryPair("c", buildBillingClientInfo(account, runtime))] : []),
    queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign)),
    queryPair("userId", account.dtUserId),
    queryPair("token", account.token)
  ];
  return parts.join("&");
}

function buildBillingProductsQueryAttempts(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  nextTrackCode: () => string
) {
  return uniqueStrings([
    buildBillingProductsQuery(account, runtime, nextTrackCode(), {
      appId: "me.dingtone.im",
      bid: "me.talktone.im",
      requireGP: 0,
      includeClientInfo: true
    }),
    buildBillingProductsQuery(account, runtime, nextTrackCode(), {
      requireGP: 1
    })
  ]);
}

function buildBillingClientInfo(
  account: { dtUserId: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig
) {
  return JSON.stringify({
    os: "android",
    appVersion: runtime.appVersion,
    appId: appIdForVariant(account.appVariant),
    deviceId: accountDeviceId(account),
    userId: account.dtUserId
  });
}

function resolvePointProductId(appVariant?: "dingtone" | "dingdong") {
  return appVariant === "dingdong" ? 0 : 3;
}

function buildRequestPrivateNumberQueryAttempts(
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  runtime: DirectRuntimeConfig,
  requestConfig: PrivatePhoneRequestConfig,
  nextTrackCode: () => string,
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
      const query = buildRequestPrivateNumberQuery(account, runtime, requestConfig, nextTrackCode(), {
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
    enableSmsReceive: {
      key: "dt_direct_api_phone_setting",
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

export function buildPrivateNumberSettingJson(phone: DirectPhoneActionContext, suspendFlag: 0 | 1) {
  const raw = collectPhoneActionRecords(phone);
  const slientFlag = pickPhoneBoolean(phone, raw, ["slientFlag", "silentFlag", "slient_flag", "silent_flag"]);
  const isSuspending = suspendFlag === 1;
  const primaryFlag = isSuspending ? false : (pickPhoneBoolean(phone, raw, ["isPrimary", "primaryFlag", "primary_flag"]) ?? true);
  const callForwardFlag = pickPhoneBoolean(phone, raw, ["callForwardFlag", "call_forward_flag"]);
  const autoRenew = pickPhoneBoolean(phone, raw, ["autoRenew", "auto_renew"]) ?? true;
  const filterSetting = {
    ...parsePrivateNumberFilterSetting(pickPhoneValue(phone, raw, ["filterSetting", "filter_setting"])),
    allowReceiveSMS: true
  };
  return {
    phoneNumber: stripPhonePrefix(phone.phoneNumber ?? pickPhoneString(phone, raw, ["phoneNumber", "phone_number"]) ?? ""),
    displayName: phone.displayName ?? pickPhoneString(phone, raw, ["displayName", "display_name"]) ?? "",
    primaryFlag: booleanFlagNumber(primaryFlag),
    faxEnabled: pickPhoneNumber(phone, raw, ["faxEnabled", "fax_enabled"]) ?? 0,
    slientFlag: booleanFlagNumber(slientFlag),
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
    filterSetting
  };
}

function booleanFlagNumber(value: boolean | undefined) {
  return value ? 1 : 0;
}

function parsePrivateNumberFilterSetting(value: unknown) {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
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
    queryPair("json", buildRecoverPasswordJson(kind, target, countryCode)),
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

function buildCheckActivatedUserQueries(kind: "email" | "phone", target: string, countryCode = 1, trackCode: string) {
  const normalizedTarget = kind === "email" ? target.trim() : stripPhonePrefix(target);
  const condition =
    kind === "email"
      ? {
          Type: 1,
          SearchWord: nativeActivationEmailMd5(normalizedTarget.toLowerCase()),
          RawEmailMD5: nativeActivationEmailMd5(normalizedTarget)
        }
      : {
          Type: 2,
          SearchWord: md5Hex(normalizedTarget),
          word: normalizedTarget
        };
  const json = JSON.stringify({ Condition: [condition] });
  const commonRestEncoderQuery = [
    queryPair("json", json),
    queryPair("TrackCode", trackCode)
  ].join("&");
  const nativeRestShapeQuery = [
    queryPair("jsonCondition", JSON.stringify({ Condition: [condition] })),
    queryPair("countryCode", kind === "phone" ? countryCode : 0),
    queryPair("areaCode", 0),
    queryPair("TrackCode", trackCode)
  ].join("&");
  return [
    commonRestEncoderQuery,
    `&${commonRestEncoderQuery}`,
    nativeRestShapeQuery
  ];
}

export async function callDirectActivationApi(runtime: DirectRuntimeConfig, identity: DirectActivationIdentity, label: string, apiName: string, query: string) {
  const apiRuntime = directActivationRuntimeForApi(runtime, apiName, identity);
  let lastError: unknown;
  for (const host of directActivationHostCandidates(apiRuntime, identity)) {
    const session = new DirectSession(apiRuntime, host);
    try {
      await session.openActivation(identity);
      if (apiName === "checkActivatedUser") {
        return await session.callCommonRestJson(label, "checkActivatedUser", query);
      }
      if (apiName === "registerEmail") {
        return await session.callConfiguredRegisterEmailTemplate(
          label,
          activationDeviceId(identity),
          buildRegisterEmailTemplateParams(query),
          activationTemplateSettingKeys("registerEmail", identity)
        );
      }
      const isDingtoneEmailActivation = apiName === "activateEmail" && typeof identity !== "string" && identity.appVariant === "dingtone";
      return await session.callConfiguredActivationTemplate(
        activationTemplateSettingKeys(apiName, identity),
        label,
        activationDeviceId(identity),
        isDingtoneEmailActivation
          ? buildActivationTemplateParamsPreservingCapturedEmailProof(query)
          : buildActivationTemplateParams(query),
        isDingtoneEmailActivation ? query : undefined
      );
    } catch (error) {
      logger.warn("Direct activation API call failed", {
        label,
        apiName,
        host,
        port: apiRuntime.port,
        useTls: apiRuntime.useTls,
        error: error instanceof Error ? error.message : String(error),
        trace: session.getTrace().slice(-6).map((frame) => ({
          frameType: frame.frameType,
          status: frame.status,
          routeHex: frame.routeHex,
          bodyLength: frame.bodyLength,
          bodyHexPreview: frame.bodyHexPreview.slice(0, 160),
          jsonPayload: summarizeJsonPayload(frame.jsonPayload)
        }))
      });
      lastError = error;
      if (isFatalDirectSessionError(error)) {
        throw error;
      }
    } finally {
      await session.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new AppError(`Direct ${label} failed`, 502, 502);
}

async function callDirectRegisterEmail(runtime: DirectRuntimeConfig, input: DingtoneLoginInput, email: string) {
  let lastPayload: ApiResult | null = null;
  let lastError: unknown;
  for (const [index, query] of buildRegisterEmailQueryAttempts(input, runtime, email).entries()) {
    try {
      const payload = await callDirectActivationApi(
        runtime,
        { appVariant: input.appVariant, deviceId: input.deviceId },
        index === 0 ? "registerEmail" : `registerEmail#${index + 1}`,
        "registerEmail",
        query
      );
      lastPayload = payload;
      assertDirectActivationOk(payload, "registerEmail");
      return payload;
    } catch (error) {
      lastError = error;
      logger.warn(`Direct registerEmail attempt ${index + 1} failed; trying next app identity if available`, {
        error: error instanceof Error ? error.message : String(error),
        payload: lastPayload ? redactSensitiveText(safeJsonStringify(lastPayload)) : null
      });
    }
  }
  if (lastError instanceof Error && /REST call failed/i.test(lastError.message)) {
    const appName = input.appVariant === "dingdong" ? "Dingdong" : "TalkU";
    const otherAppName = input.appVariant === "dingdong" ? "TalkU" : "Dingdong";
    throw new AppError(lastError.message + "; current local account type is " + appName + "; if this email belongs to " + otherAppName + ", switch/recreate the account with the correct app type and send a fresh code.", 400, 400);
  }
  throw lastError instanceof Error ? lastError : new AppError("Direct registerEmail failed", 400, 400);
}

function directActivationRuntimeForApi(
  runtime: DirectRuntimeConfig,
  apiName: string,
  identity: DirectActivationIdentity
): DirectRuntimeConfig {
  if (apiName !== "registerEmail") {
    return runtime;
  }
  return {
    ...runtime,
    port: runtime.registerEmailPort,
    useTls: runtime.registerEmailUseTls
  };
}

function directActivationHostCandidates(runtime: DirectRuntimeConfig, identity: DirectActivationIdentity) {
  if (typeof identity !== "string" && identity.appVariant === "dingtone") {
    return uniqueStrings([runtime.backupHost, runtime.primaryHost]);
  }
  return uniqueStrings([runtime.primaryHost, runtime.backupHost]);
}

function activationDeviceId(identity: DirectActivationIdentity) {
  if (typeof identity === "string") {
    return identity;
  }
  return identity.deviceId ?? "";
}

function activationRestDeviceId(value: string, appVariant?: "dingtone" | "dingdong" | string | null) {
  return normalizeActivationDeviceIdForVariant(value, appVariant);
}

function activationTemplateSettingKeys(apiName: string, identity?: DirectActivationIdentity): DirectActivationTemplateSettingKey[] {
  const baseKey = activationTemplateBaseSettingKey(apiName);
  const variantKey = activationTemplateVariantSettingKey(baseKey, identity);
  if (variantKey && (apiName === "registerEmail" || apiName === "activateEmail")) {
    return [variantKey];
  }
  return variantKey ? [variantKey, baseKey] : [baseKey];
}

function activationTemplateBaseSettingKey(apiName: string): DirectActivationTemplateSettingKey {
  if (apiName === "checkActivatedUser") {
    return "dt_direct_template_check_activated_user";
  }
  if (apiName === "activateEmail") {
    return "dt_direct_template_activate_email";
  }
  return "dt_direct_template_register_email";
}

function activationTemplateVariantSettingKey(
  baseKey: DirectActivationTemplateSettingKey,
  identity?: DirectActivationIdentity
): DirectActivationTemplateSettingKey | null {
  if (typeof identity === "string" || !identity?.appVariant) {
    return null;
  }
  const suffix = identity.appVariant === "dingdong" ? "dingdong" : "talku";
  return `${baseKey}_${suffix}` as DirectActivationTemplateSettingKey;
}

function buildActivationTemplateParams(query: string): DirectTemplateParams {
  return queryToDirectTemplateParams(query);
}

function buildActivationTemplateParamsPreservingCapturedEmailProof(query: string): DirectTemplateParams {
  return {
    ...queryToDirectTemplateParams(query),
    __preserveCapturedEnvelope: true
  };
}

function buildRegisterEmailTemplateParams(query: string): DirectTemplateParams {
  return {
    ...queryToDirectTemplateParams(query),
    __appendQueryKeys: "appType,appId"
  };
}

function queryToDirectTemplateParams(query: string): DirectTemplateParams {
  const params: DirectTemplateParams = {};
  const normalizedQuery = query.startsWith("&") ? query.slice(1) : query;
  for (const [key, value] of new URLSearchParams(normalizedQuery).entries()) {
    params[key] = value;
    if (key === "deviceId") {
      params.deviceID = value;
    }
  }
  return params;
}

function isPreserveCapturedEnvelope(params: DirectTemplateParams) {
  return params.__preserveCapturedEnvelope === true || params.__preserveCapturedEnvelope === "true";
}

function normalizeTemplateString(value: unknown) {
  const normalized = stringifyPrimitive(value);
  return normalized && normalized.trim() ? normalized : undefined;
}

export function buildRegisterEmailTemplateParamsForTest(query: string): DirectTemplateParams {
  return buildRegisterEmailTemplateParams(query);
}

export function patchQueryForTest(templateQuery: string, params: DirectTemplateParams) {
  return patchQuery(templateQuery, params);
}
function buildRegisterEmailQueryAttempts(input: DingtoneLoginInput, runtime: DirectRuntimeConfig, email: string) {
  return registerEmailIdentityAttemptsForVariant(input.appVariant).map((options) => buildRegisterEmailQuery(input, runtime, email, options));
}

export function registerEmailIdentityAttemptsForVariant(appVariant?: 'dingtone' | 'dingdong') {
  if (appVariant === 'dingdong') {
    return [
      { appType: 3, appId: DINGTONE_APP_ID, clientInfoAppId: DINGTONE_APP_ID },
      { appType: 3, appId: DINGTONE_BUSINESS_APP_ID, clientInfoAppId: DINGTONE_APP_ID },
      { appType: 2, appId: DINGTONE_APP_ID, clientInfoAppId: DINGTONE_APP_ID },
      { appType: 2, appId: DINGTONE_BUSINESS_APP_ID, clientInfoAppId: DINGTONE_APP_ID },
      { appType: undefined, appId: DINGTONE_APP_ID, clientInfoAppId: DINGTONE_APP_ID, includeTopLevelAppId: false },
      { appType: undefined, appId: DINGTONE_BUSINESS_APP_ID, clientInfoAppId: DINGTONE_APP_ID, includeTopLevelAppId: false }
    ];
  }
  return [
    { appType: 2, appId: TALKU_APP_ID, clientInfoAppId: TALKU_APP_ID },
    { appType: 3, appId: TALKU_APP_ID, clientInfoAppId: TALKU_APP_ID },
    { appType: 3, appId: DINGTONE_APP_ID, clientInfoAppId: DINGTONE_APP_ID },
    { appType: 3, appId: DINGTONE_BUSINESS_APP_ID, clientInfoAppId: DINGTONE_APP_ID },
    { appType: undefined, appId: TALKU_APP_ID, clientInfoAppId: TALKU_APP_ID, includeTopLevelAppId: false }
  ];
}

function buildRegisterEmailQuery(
  input: DingtoneLoginInput,
  runtime: DirectRuntimeConfig,
  email: string,
  options: { appType?: number; appId: string; clientInfoAppId: string; includeTopLevelAppId?: boolean }
) {
  const deviceId = activationRestDeviceId(input.deviceId, input.appVariant);
  return compactQueryPairs([
    queryPair("deviceId", deviceId),
    options.appType === undefined ? undefined : queryPair("appType", options.appType),
    options.includeTopLevelAppId === false ? undefined : queryPair("appId", options.appId),
    queryPair("apiVersion", 2),
    queryPair("countryCode", 86),
    queryPair("osType", 2),
    queryPair("deviceModel", "PCRT00"),
    queryPair("deviceName", "OPPO"),
    queryPair("activeLanguageId", 1),
    queryPair("reaskActiveCode", 0),
    queryPair("deviceOSVer", "9"),
    queryPair("showAccessCode", 1),
    queryPair("simCC", "CN"),
    queryPair("isRooted", 1),
    queryPair("isSimulator", "false"),
    queryPair("TrackCode", input.trackCode),
    queryPair("json", buildRegisterEmailJson(email)),
    queryPair("clientInfo", buildActivationClientInfo(input, runtime, { appId: options.clientInfoAppId }))
  ]);
}

function buildCheckActivatedEmailQuery(email: string, trackCode: string) {
  const condition = {
    Type: 1,
    SearchWord: nativeActivationEmailMd5(email.toLowerCase()),
    RawEmailMD5: nativeActivationEmailMd5(email)
  };
  const json = JSON.stringify({ Condition: [condition] });
  return [
    queryPair("json", json),
    queryPair("jsonCondition", json),
    queryPair("countryCode", 0),
    queryPair("areaCode", 0),
    queryPair("TrackCode", trackCode)
  ].join("&");
}

function buildActivateEmailQuery(input: DingtoneLoginInput, runtime: DirectRuntimeConfig, email: string, code: string) {
  const deviceId = activationRestDeviceId(input.deviceId, input.appVariant);
  const query = [
    queryPair("deviceId", deviceId),
    queryPair("confirmCode", code),
    queryPair("osType", 2),
    queryPair("osVersion", "9"),
    queryPair("deviceName", "OPPO"),
    queryPair("deviceModel", "PCRT00"),
    queryPair("devicepassword", ""),
    queryPair("tokenVersion", 50331648),
    queryPair("TrackCode", input.trackCode),
    queryPair("apiVersion", 1),
    queryPair("pushMessageToken", "FCM."),
    queryPair("LC", "zh"),
    queryPair("simCC", "CN"),
    queryPair("simu", 0),
    queryPair("rooted", 1)
  ];
  query.push(
    queryPair("json", buildActivationEmailJson(email)),
    queryPair("clientInfo", buildActivationClientInfo(input, runtime))
  );
  return query.join("&");
}

function buildActivationEmailJson(email: string) {
  const lowerEmail = email.toLowerCase();
  return JSON.stringify({
    Email: email,
    EmailMd5: nativeActivationEmailMd5(lowerEmail),
    EmailEncrypt: encryptActivationTarget(lowerEmail),
    RawEmailMD5: nativeActivationEmailMd5(email),
    ClientVersion: DIRECT_ACTIVATE_EMAIL_CLIENT_VERSION,
    type: 1
  });
}

function buildRegisterEmailJson(email: string) {
  const lowerEmail = email.toLowerCase();
  return JSON.stringify({
    Email: email,
    EmailMd5: nativeActivationEmailMd5(lowerEmail),
    EmailEncrypt: encryptActivationTarget(lowerEmail, { extraPaddingBlock: true }),
    RawEmailMD5: nativeActivationEmailMd5(email),
    ClientVersion: -1610218751,
    Language: 1,
    ShowAccessCode: 1,
    type: 1
  });
}

function buildActivationClientInfo(input: DingtoneLoginInput, runtime: DirectRuntimeConfig, options?: { appId?: string }) {
  const deviceId = activationRestDeviceId(input.deviceId, input.appVariant);
  const clientDeviceId = input.appVariant === "dingtone" ? normalizeActivationDeviceIdForVariant(input.deviceId, input.appVariant) : deviceId;
  const appVersion = resolveDirectAppVersion(input, runtime);
  return JSON.stringify({
    deviceOriginalId: "0000000000000000",
    advertisingId: "00000000-0000-0000-0000-000000000000",
    appVersion,
    timezone: "Asia/Shanghai",
    tzOffset: "GMT+08:00",
    simCC: "cn",
    mac: "02:00:00:00:00:00",
    imei: "000000000000000",
    mobileNum: "00000000000",
    wifiSSid: "AndroidWifi",
    language: "zh",
    serialNumber: "000000000000",
    pingTime: "100000;100000",
    mobileNetworkCarrier: {
      mcc: 460,
      mnc: 0,
      carrierNmae: "China Mobile GSM"
    },
    isoCountryCode: "CN",
    isSimulator: 0,
    rooted: 1,
    connectedV: 0,
    hasV: 0,
    appId: options?.appId ?? appIdForVariant(input.appVariant),
    deviceId: clientDeviceId,
    platform: "Android",
    manufacture: "OPPO",
    osVersion: "9",
    deviceOSVer: "9",
    deviceOSVersion: "9",
    deviceModel: "PCRT00",
    clientTime: Date.now(),
    ipv4: "10.0.2.15",
    signMd5: appVariantSign(input.appVariant, clientDeviceId, runtime.apkCertificateSign)
  });
}

function nativeActivationEmailMd5(value: string) {
  return crypto.createHash("md5")
    .update(Buffer.from(value, "utf8"))
    .update(DIRECT_ACTIVATION_EMAIL_CRYPTO_IV)
    .digest("hex");
}

function encryptActivationTarget(value: string, options?: { extraPaddingBlock?: boolean }) {
  const md5 = nativeActivationEmailMd5(value);
  const key = Buffer.from(md5.slice(0, 16), "utf8").map((byte) => (~byte) & 0xff);
  const input = Buffer.from(value, "utf8");
  const aligned = Math.ceil(input.length / 16) * 16;
  const padLength = options?.extraPaddingBlock ? aligned - input.length + 16 : (16 - (input.length % 16) || 16);
  const plain = Buffer.concat([input, Buffer.alloc(padLength, padLength & 0xff)]);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, DIRECT_ACTIVATION_EMAIL_CRYPTO_IV);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v1.", "utf8"), encrypted]).toString("base64");
}

function normalizeEmailLoginTarget(value: string | null | undefined) {
  const email = value?.trim();
  if (!email) {
    throw new AppError("Email is required for direct email verification login.", 400, 400);
  }
  return email;
}

function normalizeActivationCode(value: string | null | undefined) {
  const code = value?.trim();
  if (!code || !/^\d+$/.test(code)) {
    throw new AppError("Numeric verificationCode is required for direct email verification login.", 400, 400);
  }
  return code;
}

export function normalizeActivationDeviceIdForVariant(value: string, appVariant?: "dingtone" | "dingdong" | string | null) {
  const trimmed = value.trim();
  if (appVariant === "dingdong") {
    return trimmed.replace(/\.dttalk$/i, "");
  }
  if (/^And\.[0-9a-f]{32}$/i.test(trimmed)) {
    return `${trimmed}.dttalk`;
  }
  return trimmed;
}

export function isActivationDeviceIdAcceptedForVariant(value: string, appVariant?: "dingtone" | "dingdong" | string | null) {
  const trimmed = value.trim();
  if (appVariant === "dingdong") {
    return /^And\.[0-9a-f]{32}(?:\.dttalk)?$/i.test(trimmed);
  }
  return /^And\.[0-9a-f]{32}\.dttalk$/i.test(trimmed);
}

function assertActivationDeviceId(value: string, appVariant?: "dingtone" | "dingdong" | string | null) {
  if (!isActivationDeviceIdAcceptedForVariant(value, appVariant)) {
    throw new AppError("This verification request uses a stale deviceId. Send a new verification code first so direct mode can bind a fresh random deviceId.", 400, 400);
  }
}

function assertDirectActivationOk(payload: ApiResult, action: string) {
  const result = payload.Result ?? payload.result;
  const errCode = payload.ErrCode ?? payload.errCode ?? payload.errorCode;
  if (result === 0 || (errCode !== undefined && Number(errCode) !== 0)) {
    const reason = stringifyPrimitive(payload.Reason ?? payload.reason ?? payload.message ?? payload.error);
    const translated = translateDirectActivationError(errCode);
    logger.warn("Direct activation API returned an error payload", {
      action,
      errCode,
      result,
      reason: reason ? redactSensitiveText(reason) : null,
      payload: redactSensitiveText(safeJsonStringify(payload))
    });
    throw new AppError(
      `Direct ${action} failed: ${reason ? redactSensitiveText(reason) : translated ?? `server returned ${String(errCode ?? result)}`}`,
      400,
      400
    );
  }
}

function isDirectActivationErrorCode(payload: ApiResult, expected: number) {
  const errCode = payload.ErrCode ?? payload.errCode ?? payload.errorCode;
  return Number(errCode) === expected;
}

function translateDirectActivationError(errCode: unknown) {
  const code = Number(errCode);
  if (code === 60095) {
    return "verification email was requested too frequently; wait for the server cooldown, then send a fresh code";
  }
  return null;
}

function md5Hex(value: string) {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

function appIdForVariant(appVariant?: "dingtone" | "dingdong") {
  return appVariant === "dingdong" ? DINGTONE_APP_ID : TALKU_APP_ID;
}

function activationBusinessAppIdForVariant(appVariant?: "dingtone" | "dingdong") {
  return appVariant === "dingdong" ? DINGTONE_BUSINESS_APP_ID : TALKU_APP_ID;
}

function resolveDirectAppVersion(identity: { appVariant?: "dingtone" | "dingdong" } | undefined, runtime: DirectRuntimeConfig) {
  return identity?.appVariant === "dingdong" ? runtime.dingdongAppVersion : runtime.appVersion;
}

function appVariantSign(appVariant: "dingtone" | "dingdong" | undefined, deviceId: string, fallback: string) {
  if (appVariant === "dingdong") {
    return fallback;
  }
  return resolveDirectAccountApkCertificateSign({ appVariant, deviceId }, fallback);
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

function buildRecoverPasswordJson(kind: "email" | "phone", target: string, countryCode = 1) {
  return JSON.stringify(
    kind === "email"
      ? { countryCode, email: target }
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

function compactQueryPairs(pairs: Array<string | undefined>) {
  return pairs.filter((pair): pair is string => Boolean(pair)).join("&");
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

function frameToDirectFrameSummary(frame: ParsedFrame): DirectProbePushResult {
  return {
    receivedAt: new Date().toISOString(),
    frameType: frame.type,
    status: frame.status,
    routeHex: frame.route?.toString("hex"),
    bodyLength: frame.body.length,
    rawHexPreview: frame.raw.subarray(0, 160).toString("hex"),
    bodyHexPreview: frame.body.subarray(0, 160).toString("hex"),
    jsonPayload: null,
    sms: null
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
    jsonPayload: null,
    sms: tryParseSmsPush(frame.raw) ?? tryParseSmsPush(frame.body)
  };
}

function isNotifyOnlyMessageIndexPush(push: DirectProbePushResult) {
  if (push.status !== 0x0103 || push.sms) {
    return false;
  }
  return Boolean(
    (push.rawHex && isOfflineMessageIndexPush(Buffer.from(push.rawHex, "hex"))) ||
      (push.bodyHex && isOfflineMessageIndexPush(Buffer.from(push.bodyHex, "hex")))
  );
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
  US: "缂傚洤楠稿ù?+1",
  CA: "闁告梻濮电€ｄ焦寰?+1",
  GB: "闁艰宕ù?+44",
  BE: "婵絾鏌ㄩ崺鍕籍?+32",
  NL: "闁艰棄鍢查崣?+31",
  RU: "濞ｅ洤瀚紞蹇涘棘?+7",
  ES: "閻熸娉曡ぐ顕€鎮?+34",
  CN: "濞戞搩鍘煎ù?+86",
  AU: "婵犮垹鍟块妵鍥礆閳衡偓缁?+61",
  AT: "濠靛倶鍎卞﹢鎾礆?+43",
  FR: "婵炲娲栧ù?+33",
  SE: "闁荤喓鍋涢崥鈧?+46",
  MU: "婵絾鐩崳宄靶ч崒娑欑効 +230",
  PL: "婵炲鍨归崣?+48",
  ID: "闁告婢樼€瑰磭浜搁懝鑸仾濞?+62",
  PR: "婵炲鍨归ˇ鎸庮渶鎼粹剝鍊?+1787",
  CZ: "闁圭懓鍢查崢?+420",
  MY: "濡炶鍓氬鐢垫啿婢跺摜鑲?+60",
  DK: "濞戞挸缍婄€?+45",
  RO: "缂傚啯顨婇埞鍫焊闂傚鑲?+40"
};

const APP_PHONE_COUNTRY_DISPLAY_NAMES: Record<string, string> = {
  US: 'US',
  CA: 'CA',
  GB: 'GB',
  BE: 'BE',
  NL: 'NL',
  RU: 'RU',
  ES: 'ES',
  CN: 'CN',
  AU: 'AU',
  AT: 'AT',
  FR: 'FR',
  SE: 'SE',
  MU: 'MU',
  PL: 'PL',
  ID: 'ID',
  PR: 'PR',
  CZ: 'CZ',
  MY: 'MY',
  DK: 'DK',
  RO: 'RO'
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
    phoneNumber: pickString(record, ["phoneNumber", "phone_number", "number", "privateNumber", "private_number", "userNumber", "user_number"]) ?? "",
    countryCode: pickNumber(record, ["countryCode", "country_code", "cc"]),
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
    allowReceiveSms: parsePhoneAllowReceiveSms(record),
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
    allowReceiveSms: normalized.allowReceiveSms,
    portoutInfo: normalized.portoutInfo,
    rawJson: normalized.rawJson
  };
}

function parsePhoneAllowReceiveSms(record: Record<string, unknown>) {
  const keys = ["allowReceiveSMS", "allowReceiveSms", "allow_receive_sms"];
  for (const candidate of collectNestedRecords(record)) {
    const direct = pickBoolean(candidate, keys);
    if (direct !== undefined) {
      return direct;
    }
    const filterSetting = candidate.filterSetting ?? candidate.filter_setting;
    if (isRecord(filterSetting)) {
      const nested = pickBoolean(filterSetting, keys);
      if (nested !== undefined) {
        return nested;
      }
    }
    if (typeof filterSetting === "string" && filterSetting.trim()) {
      try {
        const parsed = JSON.parse(filterSetting) as unknown;
        if (isRecord(parsed)) {
          const nested = pickBoolean(parsed, keys);
          if (nested !== undefined) {
            return nested;
          }
        }
      } catch {
        // Ignore malformed legacy filter settings and keep searching nested records.
      }
    }
  }
  return undefined;
}

function pickPhoneValue(phone: DirectPhoneActionContext, records: Record<string, unknown>[], keys: string[]) {
  for (const record of [phone as Record<string, unknown>, ...records]) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        return record[key];
      }
    }
  }
  return undefined;
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
  const expireAt = expireTime ? (expireTime > 1_000_000_000_000 ? expireTime : expireTime * 1000) : null;
  if (expireAt && expireAt <= Date.now()) {
    return "expired";
  }
  return "active";
}

async function collectDirectProfileSnapshot(
  session: DirectSession,
  _runtime: DirectRuntimeConfig,
  _account: { dtUserId: string; token: string; deviceId?: string | null },
  _shared: DirectTemplateParams,
  _nextTrackCode: () => string
) {
  const profile: Record<string, unknown> = {};
  profile.bootstrap = session.getBootstrapPayloads();
  return profile;
}

async function collectDirectPointSnapshot(
  session: DirectSession,
  runtime: DirectRuntimeConfig,
  account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
  nextTrackCode: () => string
) {
  const summaryQuery = buildPointSummaryQuery(account, runtime, nextTrackCode(), resolvePointProductId(account.appVariant));
  const summary = await session.callCommonRestJson("pointSummary", "/point/summary", summaryQuery, DIRECT_REFRESH_ATTEMPT_TIMEOUT_MS).catch((error: unknown) => ({
    refreshError: error instanceof Error ? error.message : String(error ?? "unknown direct point summary error")
  }));
  const summaryRecords = collectNestedRecords(summary);
  const uid = pickStringFromRecords(summaryRecords, ["uid", "pointUid", "point_uid"]);
  const gradeInfo = uid
    ? await session
        .callCommonRestJson(
          "pointGradeInfo",
          "/point/gradeinfo",
          buildPointGradeInfoQuery(account, runtime, nextTrackCode(), uid),
          DIRECT_REFRESH_ATTEMPT_TIMEOUT_MS
        )
        .catch((error: unknown) => ({
          refreshError: error instanceof Error ? error.message : String(error ?? "unknown direct point gradeinfo error")
        }))
    : null;
  return { summary, gradeInfo, uid };
}

async function callFirstCommonRestJson(
  session: DirectSession,
  label: string,
  apiName: string,
  queries: string[]
) {
  let lastError: unknown;
  for (const [index, query] of queries.entries()) {
    try {
      return await session.callCommonRestJson(index === 0 ? label : `${label}#${index + 1}`, apiName, query, DIRECT_REFRESH_ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
    }
  }
  return {
    refreshError: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown direct point request error")
  };
}

async function callBestBalanceCommonRestJson(
  session: DirectSession,
  label: string,
  apiName: string,
  queries: string[]
) {
  let firstBalancePayload: ApiResult | null = null;
  let lastError: unknown;

  for (const [index, query] of queries.entries()) {
    try {
      const payload = await session.callCommonRestJson(
        index === 0 ? label : `${label}#${index + 1}`,
        apiName,
        query,
        DIRECT_REFRESH_ATTEMPT_TIMEOUT_MS
      );
      if (hasPositiveBalancePayload(payload)) {
        return payload;
      }
      if (!firstBalancePayload && isBalancePayload(payload)) {
        firstBalancePayload = payload;
      }
    } catch (error) {
      lastError = error;
    }
  }

  return (
    firstBalancePayload ?? {
      refreshError: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown direct balance request error")
    }
  );
}

function buildSnapshot(input: {
  account: { dtUserId: string; token: string; email?: string | null; phone?: string | null };
  balance: ApiResult;
  userSetting: ApiResult;
  profile: ApiResult;
  point: ApiResult;
}): DingtoneSnapshot {
  const balance = collectRecords(input.balance);
  const settings = collectRecords(input.userSetting);
  const profile = collectNestedRecords(input.profile);
  const point = collectNestedRecords(input.point);
  const primaryBalance = normalizeDirectPrimaryBalance(balance);
  const raw = {
    balance: input.balance,
    userSetting: input.userSetting,
    profile: input.profile,
    point: input.point
  };
  return {
    dtDingtoneId: pickStringFromRecords(profile, ["dingtoneId", "dtDingtoneId", "DingtoneId", "DingtoneID", "publicUserId"]),
    fullName:
      pickStringFromRecords(profile, ["fullName", "full_name", "displayName", "DisplayName", "nickname", "nickName"]) ??
      pickStringFromRecords(point, ["userName", "nickName", "nickname"]),
    avatarUrl: pickStringFromRecords(profile, ["avatarUrl", "avatar_url", "photoUrl"]),
    gender: pickNumberFromRecords(profile, ["gender", "sex"]),
    birthday: pickStringFromRecords(profile, ["birthday", "birthDay"]),
    email: input.account.email ?? pickStringFromRecords(profile, ["email"]),
    phone: input.account.phone ?? pickStringFromRecords(profile, ["phone", "phoneNumber", "phone_number"]),
    aboutMe: pickStringFromRecords(profile, ["aboutMe", "about_me", "signature"]),
    feeling: pickStringFromRecords(profile, ["feeling", "mood"]),
    company: pickStringFromRecords(profile, ["company"]),
    school: pickStringFromRecords(profile, ["school"]),
    country: pickStringFromRecords(profile, ["country", "countryName", "IpISOCountryCode", "ipIsoCountryCode", "IpCountryCode"]),
    state: pickStringFromRecords(profile, ["state", "province", "IpCountryRegion", "ipCountryRegion"]),
    city: pickStringFromRecords(profile, ["city", "IpCity", "ipCity"]),
    primaryBalance,
    userGrade: normalizeDirectUserGrade(pickNumberFromRecords([...point, ...balance], ["userGrade", "user_grade", "grade"])),
    validPoint: normalizeMemberPoint(pickNumberFromRecords([...point, ...balance], ["validPoint", "valid_point"])),
    progressPoint: normalizeMemberPoint(pickNumberFromRecords([...point, ...balance], ["progessPoint", "progressPoint", "progress_point", "historyPoint"])),
    progressPointTotal: pickNumberFromRecords([...point, ...balance], [
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

function extractActivatedEmailUser(payload: ApiResult) {
  const records = collectNestedRecords(payload);
  const dtUserId = pickStringFromRecords(records, ["UserId", "userId", "UserID", "uid", "dtUserId", "dt_user_id"]);
  const dingtoneId = pickStringFromRecords(records, ["DingtoneId", "DingtoneID", "dingtoneId", "dtDingtoneId"]);
  if (!dtUserId && !dingtoneId) {
    return null;
  }
  return { dtUserId, dingtoneId };
}

function extractActivationDeviceId(payload: ApiResult) {
  const records = collectNestedRecords(payload);
  const direct = pickStringFromRecords(records, ["deviceId", "deviceID", "DeviceId", "DeviceID"]);
  if (direct) {
    return direct;
  }
  for (const record of records) {
    const raw = pickString(record, ["CreditInterceptionKey", "creditInterceptionKey", "credit_interception_key"]);
    if (!raw) {
      continue;
    }
    const parsed = parseJsonRecord(raw);
    const deviceId = parsed ? pickString(parsed, ["deviceId", "deviceID", "DeviceId", "DeviceID"]) : null;
    if (deviceId) {
      return deviceId;
    }
  }
  return null;
}

async function extractConfiguredActivationTemplateDeviceId(
  settingKey: DirectActivationTemplateSettingKey | DirectActivationTemplateSettingKey[],
  confirmCode: string
) {
  const configured = await getConfiguredDirectTemplateFromKeys(settingKey);
  const template = configured?.template ?? null;
  if (!template) {
    return null;
  }
  const templateBuffer = Buffer.from(template.hex.replace(/\s+/g, ""), "hex");
  if (templateQueryParam(templateBuffer, "confirmCode") !== confirmCode) {
    return null;
  }
  const direct = templateQueryParam(templateBuffer, "deviceId") ?? templateQueryParam(templateBuffer, "deviceID");
  if (direct) {
    return direct;
  }
  for (const key of ["clientInfo", "json"]) {
    const raw = templateQueryParam(templateBuffer, key);
    const parsed = raw ? parseJsonRecord(raw) : null;
    const deviceId = parsed ? pickString(parsed, ["deviceId", "deviceID", "DeviceId", "DeviceID", "LDid"]) : null;
    if (deviceId) {
      return deviceId;
    }
  }
  return null;
}

function normalizeDirectPrimaryBalance(records: Record<string, unknown>[]) {
  const value = pickNumberFromRecords(records, [
    "primaryBalance",
    "primary_balance",
    "balance",
    "balanceAmount",
    "balance_amount",
    "availableBalance",
    "available_balance",
    "walletBalance",
    "wallet_balance",
    "coinBalance",
    "coin_balance",
    "creditBalance",
    "credit_balance"
  ]);
  if (value === undefined) {
    return undefined;
  }
  const ratio = pickPositiveNumberFromRecords(records, ["creditExchangeRatio", "credit_exchange_ratio"]);
  if (value < 1000 && ratio && ratio > 0) {
    return Math.round((value / ratio) * 100) / 100;
  }
  return value;
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

function pickPositiveNumberFromRecords(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    const value = pickNumber(record, keys);
    if (value !== undefined && value > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeDirectUserGrade(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return value + 1;
}

function normalizeMemberPoint(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value > 10_000) {
    return undefined;
  }
  return value;
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

function accountDeviceId(account: { dtUserId: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" }) {
  const existing = account.deviceId;
  if (existing && existing.trim()) {
    return existing.trim();
  }
  return `And.${hashLike(account.dtUserId)}.dttalk`;
}

function resolveDirectAccountAppId(identity: string | DirectAccountIdentity) {
  return isTalkUIdentity(identity) ? TALKU_APP_ID : DINGTONE_APP_ID;
}

function resolveDirectAccountApkCertificateSign(identity: string | DirectAccountIdentity, fallback: string) {
  return "cf093a0e6b07dce3c8e05f7d4a9c261c";
}

function resolveDirectApiApkCertificateSign(identity: string | DirectAccountIdentity, fallback: string) {
  return isTalkUIdentity(identity) ? TALKU_DIRECT_API_CERTIFICATE_SIGN : fallback;
}

function isTalkUIdentity(identity: string | DirectAccountIdentity) {
  if (typeof identity !== "string") {
    if (identity.appVariant === "dingdong") {
      return false;
    }
    if (identity.appVariant === "dingtone") {
      return true;
    }
    return isTalkUDeviceId(identity.deviceId ?? "");
  }
  return isTalkUDeviceId(identity);
}

function isTalkUDeviceId(deviceId: string) {
  const normalized = deviceId.trim().toLowerCase();
  return normalized.endsWith(".dttalk") || normalized.includes("dttalk");
}

function directSessionAccountKey(account: { dtUserId: string; deviceId?: string | null }) {
  return account.dtUserId;
}

function createDirectRouteCoordinator(primaryHost: string) {
  let owner: string | null = null;
  let ownerEpoch = 0;
  let backupEligible = false;

  return {
    shouldClaim(host: string) {
      return host === primaryHost || (backupEligible && owner === null);
    },
    claim(host: string) {
      owner = host;
      ownerEpoch += 1;
      if (host === primaryHost) {
        backupEligible = false;
      }
      return ownerEpoch;
    },
    release(host: string, epoch: number) {
      if (owner !== host || ownerEpoch !== epoch) {
        return;
      }
      owner = null;
      if (host === primaryHost) {
        backupEligible = true;
      }
    },
    markPrimaryUnavailable() {
      if (owner === primaryHost) {
        owner = null;
        ownerEpoch += 1;
      }
      backupEligible = true;
    },
    ownerHost() {
      return owner;
    },
    isOwner(host: string, epoch: number) {
      return owner === host && ownerEpoch === epoch;
    }
  };
}

export function createDirectRouteCoordinatorForTest(primaryHost: string) {
  return createDirectRouteCoordinator(primaryHost);
}

function getPrioritizedDirectPushHosts(
  runtime: Pick<DirectRuntimeConfig, "primaryHost" | "backupHost">,
  account: { dtUserId: string; deviceId?: string | null }
) {
  const preferredHosts = directSmsHostAffinity.get(directSessionAccountKey(account)) ?? [];
  return uniqueHosts([...preferredHosts, ...APP_DIRECT_PUSH_HOSTS, runtime.primaryHost, runtime.backupHost]);
}

function rememberDirectSmsHost(account: { dtUserId: string; deviceId?: string | null }, host: string) {
  const key = directSessionAccountKey(account);
  const previous = directSmsHostAffinity.get(key) ?? [];
  directSmsHostAffinity.set(key, [host, ...previous.filter((item) => item !== host)].slice(0, 6));
}

function isActiveDirectPushListener(listener: ActiveDirectPushListener) {
  return !listener.preempted && activeDirectPushListeners.get(listener.key) === listener;
}

async function preemptActiveDirectPushListener(account: { dtUserId: string; deviceId?: string | null }) {
  const active = activeDirectPushListeners.get(directSessionAccountKey(account));
  if (!active) {
    return false;
  }
  if (active.preempted) {
    await active.done;
    return true;
  }
  active.preempted = true;
  void active.session?.close().catch(() => undefined);
  for (const session of active.sessions ?? []) {
    void session.close().catch(() => undefined);
  }
  await active.done;
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

async function waitForDirectSessionOperationIdle(
  account: { dtUserId: string; deviceId?: string | null },
  timeoutMs = DIRECT_SESSION_OPERATION_IDLE_WAIT_MS
) {
  const active = directSessionOperationLocks.get(directSessionAccountKey(account));
  if (!active) {
    return true;
  }
  return Promise.race([
    active.then(() => true, () => true),
    delay(Math.max(1, timeoutMs)).then(() => false)
  ]);
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
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

export async function getDirectRuntimeConfig(): Promise<DirectRuntimeConfig> {
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  return {
    primaryHost: settings.dt_server_ip || config.DT_SERVER_IP,
    backupHost: settings.dt_backup_ip || config.DT_BACKUP_IP,
    port: Number(settings.dt_server_port || config.DT_SERVER_PORT) || config.DT_SERVER_PORT,
    registerEmailPort: parsePositiveIntSetting(settings.dt_direct_register_email_port, 465, 1, 65535),
    connectTimeoutMs: 10_000,
    ioTimeoutMs: 15_000,
    useTls: parseBooleanSetting(settings.dt_direct_use_tls, config.DT_DIRECT_USE_TLS),
    registerEmailUseTls: parseBooleanSetting(settings.dt_direct_register_email_use_tls, true),
    appVersion: config.DT_APP_VERSION,
    dingdongAppVersion: settings.dt_dingdong_app_version || config.DT_DINGDONG_APP_VERSION,
    apkCertificateSign: config.DT_APK_CERTIFICATE_SIGN,
    proxyUrl: (settings.dt_proxy_url || config.DT_PROXY_URL || "").trim()
  };
}

async function getConfiguredDirectTemplate(key: DirectTemplateSettingKey): Promise<DirectActionTemplate | null> {
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  return parseDirectActionTemplate(key, settings[key]);
}

async function getConfiguredDirectTemplateFromKeys(
  keys: DirectTemplateSettingKey | DirectTemplateSettingKey[]
): Promise<{ key: DirectTemplateSettingKey; template: DirectActionTemplate } | null> {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  const baseKey = keyList.length > 1 ? keyList[keyList.length - 1] : null;
  for (const [index, key] of keyList.entries()) {
    const rawValue = settings[key];
    if (String(rawValue ?? "").trim()) {
      const template = parseDirectActionTemplate(key, rawValue);
      return template ? { key, template } : null;
    }
  }
  return null;
}

function hasConfiguredActivationVariantTemplate(settings: Record<string, string>, baseKey: DirectTemplateSettingKey) {
  return Boolean(
    String(settings[`${baseKey}_talku`] ?? "").trim() ||
      String(settings[`${baseKey}_dingdong`] ?? "").trim()
  );
}

function formatDirectTemplateKeys(keys: DirectTemplateSettingKey | DirectTemplateSettingKey[]) {
  return Array.isArray(keys) ? keys.join(" or ") : keys;
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

async function connectSocketViaHttpProxy(input: {
  proxyUrl: string;
  host: string;
  port: number;
  useTls: boolean;
  timeoutMs: number;
}) {
  let proxy: URL;
  try {
    proxy = new URL(input.proxyUrl);
  } catch {
    throw new AppError("DT_PROXY_URL must be a valid http:// or https:// proxy URL for direct mode.", 400, 400);
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new AppError("Direct mode currently supports HTTP CONNECT proxies only. Use http:// or https:// in DT_PROXY_URL.", 400, 400);
  }

  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  const socket = proxy.protocol === "https:"
    ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost, rejectUnauthorized: false })
    : net.connect({ host: proxyHost, port: proxyPort });

  await waitForSocketConnect(socket, input.timeoutMs, `Direct proxy connection timed out: ${proxyHost}:${proxyPort}`);
  const connected = await performHttpConnect(socket, proxy, input.host, input.port, input.timeoutMs);

  if (!input.useTls) {
    return connected;
  }

  const tlsSocket = tls.connect({
    socket: connected,
    servername: input.host,
    rejectUnauthorized: false
  });
  await waitForSocketConnect(tlsSocket, input.timeoutMs, `Direct TLS connection timed out through proxy: ${input.host}:${input.port}`);
  return tlsSocket;
}

function waitForSocketConnect(socket: net.Socket, timeoutMs: number, timeoutMessage: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AppError(timeoutMessage, 504, 504));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("secureConnect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("secureConnect", onConnect);
    socket.once("error", onError);
  });
}

function performHttpConnect(socket: net.Socket, proxy: URL, host: string, port: number, timeoutMs: number) {
  return new Promise<net.Socket>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AppError(`Direct proxy CONNECT timed out: ${host}:${port}`, 504, 504));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new AppError("Direct proxy CONNECT socket closed before tunnel was established.", 502, 502));
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("latin1");
      const status = Number(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1]);
      cleanup();
      if (status < 200 || status >= 300) {
        socket.destroy();
        reject(new AppError(`Direct proxy CONNECT failed with HTTP ${Number.isFinite(status) ? status : "unknown"}.`, 502, 502));
        return;
      }
      resolve(socket);
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(buildHttpConnectRequest(proxy, host, port));
  });
}

function buildHttpConnectRequest(proxy: URL, host: string, port: number) {
  const target = `${host}:${port}`;
  const lines = [
    `CONNECT ${target} HTTP/1.1`,
    `Host: ${target}`,
    "Proxy-Connection: Keep-Alive",
    "Connection: Keep-Alive"
  ];
  if (proxy.username || proxy.password) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
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

export function isSocketClosedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /socket.*(?:closed|ended|not writable)|(?:closed|ended).*socket|stream was destroyed|write after (?:a stream was destroyed|end)|econn(?:aborted|reset)|socket hang up/i.test(message);
}

function isDirectTransportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    isSocketClosedError(error) ||
    /direct (?:gateway|proxy|tls) connection timed out|econnrefused|enotfound|etimedout|network socket disconnected/i.test(message)
  );
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
