import { PhoneStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";
import type { DingtonePhoneNumber } from "./dingtone/types.js";

export type PhoneNumberStore = {
  upsert(args: {
    where: { accountId_phoneNumber: { accountId: number; phoneNumber: string } };
    update: Prisma.PhoneNumberUncheckedUpdateInput;
    create: Prisma.PhoneNumberUncheckedCreateInput;
  }): Promise<unknown>;
  count(args: { where: { accountId: number; phoneNumber: { notIn: string[] } } }): Promise<number>;
};

export function mapPhoneNumberBase(item: Partial<DingtonePhoneNumber>) {
  return {
    countryCode: item.countryCode,
    providerId: item.providerId,
    displayName: item.displayName,
    status: item.status ? (item.status as PhoneStatus) : undefined,
    purchaseType: item.purchaseType,
    payType: item.payType,
    validPeriodDays: item.validPeriodDays,
    gainTime: item.gainTime,
    expiredTime: item.expiredTime,
    autoRenew: item.autoRenew ?? false,
    isPrimary: item.isPrimary ?? false,
    isGoodNumber: item.isGoodNumber ?? false,
    portoutInfo: item.portoutInfo,
    rawJson: item.rawJson ?? JSON.stringify(item)
  };
}

export function mapPhoneNumberCreate(
  accountId: number,
  item: DingtonePhoneNumber
): Prisma.PhoneNumberUncheckedCreateInput {
  return {
    accountId,
    phoneNumber: item.phoneNumber,
    ...mapPhoneNumberBase(item)
  };
}

export function mapPhoneNumberPatch(
  item: Partial<DingtonePhoneNumber>
): Prisma.PhoneNumberUncheckedUpdateInput {
  return mapPhoneNumberBase(item);
}

export async function syncPhoneNumbersWithStore(
  accountId: number,
  phoneNumbers: DingtonePhoneNumber[],
  store: PhoneNumberStore
) {
  const remoteSet = new Set<string>();
  let persisted = 0;
  for (const item of phoneNumbers) {
    if (!item.phoneNumber) {
      continue;
    }
    remoteSet.add(item.phoneNumber);
    await store.upsert({
      where: {
        accountId_phoneNumber: {
          accountId,
          phoneNumber: item.phoneNumber
        }
      },
      update: mapPhoneNumberPatch(item),
      create: mapPhoneNumberCreate(accountId, item)
    });
    persisted += 1;
  }

  const missingLocalCount = remoteSet.size
    ? await store.count({
        where: {
          accountId,
          phoneNumber: { notIn: Array.from(remoteSet) }
        }
      })
    : 0;
  return { persisted, missingLocalCount };
}

export async function syncPhoneNumbers(accountId: number, phoneNumbers: DingtonePhoneNumber[]) {
  const result = await syncPhoneNumbersWithStore(
    accountId,
    phoneNumbers,
    prisma.phoneNumber as unknown as PhoneNumberStore
  );
  if (result.missingLocalCount > 0) {
    logger.warn("Remote phone sync omitted local phone records; keeping local rows instead of deleting them", {
      accountId,
      missingCount: result.missingLocalCount
    });
  }
  return result;
}
