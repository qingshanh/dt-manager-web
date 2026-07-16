import type { AppVariant } from "@prisma/client";

export function buildSameVariantDuplicateAccountWhere(input: {
  id: number;
  adminId: number;
  appVariant: AppVariant;
  dtUserId: string;
}) {
  return {
    adminId: input.adminId,
    appVariant: input.appVariant,
    dtUserId: input.dtUserId,
    NOT: { id: input.id }
  };
}
