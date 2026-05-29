import { prisma } from "../lib/prisma.js";
import { serializeMessage } from "../utils/serializers.js";

export async function getDashboardStats() {
  const activeAccountFilter = {
    NOT: {
      status: "pending" as const
    }
  };
  const [totalAccounts, onlineAccounts, totalMessages, unreadMessages, totalPhoneNumbers, activePhoneNumbers] = await Promise.all([
    prisma.dtAccount.count({ where: activeAccountFilter }),
    prisma.dtAccount.count({ where: { ...activeAccountFilter, status: "online" } }),
    prisma.message.count(),
    prisma.message.count({ where: { isRead: false } }),
    prisma.phoneNumber.count(),
    prisma.phoneNumber.count({ where: { status: "active" } })
  ]);

  return {
    totalAccounts,
    onlineAccounts,
    totalMessages,
    unreadMessages,
    totalPhoneNumbers,
    activePhoneNumbers
  };
}

export async function getRecentMessages(limit = 20) {
  const messages = await prisma.message.findMany({
    take: limit,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    include: {
      account: {
        select: {
          id: true,
          nickname: true,
          appVariant: true
        }
      }
    }
  });
  return messages.map((message) => ({
    ...serializeMessage(message),
    account: message.account
  }));
}
