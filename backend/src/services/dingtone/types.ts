export type DingtoneLoginInput = {
  loginType: "email_code" | "phone_code" | "email_password" | "phone_password" | "manual_session";
  appVariant?: "dingtone" | "dingdong";
  email?: string | null;
  phone?: string | null;
  password?: string | null;
  verificationCode?: string | null;
  deviceId: string;
  trackCode: string;
};

export type DingtoneLoginResult = {
  dtUserId: string;
  token: string;
  deviceId?: string;
  dingtoneId?: string;
  routeAddress?: string;
  serverIp?: string;
  serverPort?: number;
};

export type DingtoneSessionExport = {
  dtUserId: string;
  token: string;
  deviceId: string;
  dingtoneId?: string;
  appVariant?: "dingtone" | "dingdong";
  packageName?: string;
  deviceIdCandidates?: string[];
  activatedEmail?: string | null;
  mainPhone?: string | null;
  snapshot?: DingtoneSnapshot;
  phoneNumbers?: DingtonePhoneNumber[];
};

export type DingtoneSessionExportInput = {
  appVariant?: "dingtone" | "dingdong";
  account?: {
    dtUserId?: string | null;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
  };
};

export type DingtoneSnapshot = {
  dtDingtoneId?: string;
  fullName?: string;
  avatarUrl?: string;
  gender?: number;
  birthday?: string;
  email?: string;
  phone?: string;
  aboutMe?: string;
  feeling?: string;
  company?: string;
  school?: string;
  country?: string;
  state?: string;
  city?: string;
  primaryBalance?: number;
  userGrade?: number;
  validPoint?: number;
  progressPoint?: number;
  progressPointTotal?: number;
  membershipType?: string;
  membershipLevelLabel?: string;
  membershipExpireAt?: Date | null;
  profileVerCode?: string;
  rawJson?: string;
};

export type DingtonePhoneNumber = {
  phoneNumber: string;
  countryCode?: number;
  areaCode?: number;
  providerId?: number;
  packageServiceId?: string;
  displayName?: string;
  status?: "active" | "paused" | "expired" | "cancelled" | "pending";
  purchaseType?: number;
  payType?: number;
  validPeriodDays?: number;
  gainTime?: string;
  expiredTime?: string;
  autoRenew?: boolean;
  isPrimary?: boolean;
  isGoodNumber?: boolean;
  portoutInfo?: string;
  rawJson?: string;
};

export type DingtonePhonePurchaseCandidate = {
  phoneNumber: string;
  countryCode?: number;
  areaCode?: number;
  providerId?: number;
  packageServiceId?: string;
  category?: number;
  phoneType?: number;
  displayName?: string;
  cityName?: string;
  stateName?: string;
  isoCountryCode?: string;
  goodNumberLevel?: number;
  useHistory?: number;
  price?: number;
  productId?: string;
  rawJson?: string;
};

export type DingtonePhonePurchasePreview = {
  freeChance?: number;
  candidates: DingtonePhonePurchaseCandidate[];
  rawJson?: string;
};

export type DingtonePhoneCountryOption = {
  countryKey: string;
  label: string;
  countryCode: number;
  isoCountryCode: string;
  providerIdList?: string[];
  available?: boolean;
  rawJson?: string;
};

export type VerificationRequestResult = {
  message: string;
  mock?: boolean;
  verificationCode?: string;
};

export type DingtoneGateway = {
  sendVerificationCode(input: DingtoneLoginInput): Promise<VerificationRequestResult>;
  login(input: DingtoneLoginInput): Promise<DingtoneLoginResult>;
  exportSession(input: DingtoneSessionExportInput): Promise<DingtoneSessionExport>;
  refreshSnapshot(account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
    appVariant?: "dingtone" | "dingdong";
  }): Promise<DingtoneSnapshot>;
  listPhoneNumbers(account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" }): Promise<DingtonePhoneNumber[]>;
  requestPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
    payload: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; areaCode?: number | null }
  ): Promise<DingtonePhonePurchasePreview>;
  purchasePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
    payload: {
      countryCode?: number;
      isoCountryCode?: string | null;
      countryKey?: string | null;
      candidate: DingtonePhonePurchaseCandidate;
    }
  ): Promise<DingtonePhoneNumber>;
  renewPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: Partial<DingtonePhoneNumber>
  ): Promise<Partial<DingtonePhoneNumber>>;
  updatePhoneNumberLabel?(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    displayName: string
  ): Promise<Partial<DingtonePhoneNumber>>;
  cancelPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: Partial<DingtonePhoneNumber>
  ): Promise<void>;
  pausePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: Partial<DingtonePhoneNumber>
  ): Promise<void>;
  resumePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: Partial<DingtonePhoneNumber>
  ): Promise<void>;
};
