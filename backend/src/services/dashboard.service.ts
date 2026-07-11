import { MessageType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { serializeMessage } from "../utils/serializers.js";

export async function getDashboardStats(adminId: number) {
  const activeAccountFilter = {
    adminId,
    NOT: {
      status: "pending" as const
    }
  };
  const [totalAccounts, onlineAccounts, totalMessages, unreadMessages, totalPhoneNumbers, activePhoneNumbers] = await Promise.all([
    prisma.dtAccount.count({ where: activeAccountFilter }),
    prisma.dtAccount.count({ where: { ...activeAccountFilter, status: "online" } }),
    prisma.message.count({ where: { account: { adminId } } }),
    prisma.message.count({
      where: { account: { adminId }, isRead: false, msgType: { not: MessageType.system } }
    }),
    prisma.phoneNumber.count({ where: { account: { adminId } } }),
    prisma.phoneNumber.count({ where: { account: { adminId }, status: "active" } })
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

export async function getRecentMessages(limit = 20, adminId?: number) {
  const messages = await prisma.message.findMany({
    where: {
      msgType: { not: MessageType.system },
      ...(adminId ? { account: { adminId } } : {})
    },
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

export async function getUnreadNotifications(adminId: number, limit = 20) {
  const unreadWhere = {
    account: { adminId },
    isRead: false,
    msgType: { not: MessageType.system }
  };
  const [unreadCount, messages] = await Promise.all([
    prisma.message.count({ where: unreadWhere }),
    prisma.message.findMany({
      where: unreadWhere,
      take: limit,
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      include: {
        account: {
          select: { id: true, nickname: true, appVariant: true }
        }
      }
    })
  ]);
  return {
    unread_count: unreadCount,
    list: messages.map((message) => ({ ...serializeMessage(message), account: message.account }))
  };
}

export async function markAllMessagesRead(adminId: number) {
  return prisma.message.updateMany({
    where: { account: { adminId }, isRead: false },
    data: { isRead: true }
  });
}
