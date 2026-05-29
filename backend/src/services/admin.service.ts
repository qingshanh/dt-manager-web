import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { AppError } from "../utils/errors.js";

export async function ensureDefaultAdmin() {
  const existing = await prisma.adminUser.findUnique({
    where: { username: config.ADMIN_USERNAME }
  });
  if (existing) {
    return existing;
  }

  const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({
    data: {
      username: config.ADMIN_USERNAME,
      passwordHash
    }
  });
}

export async function verifyAdmin(username: string, password: string) {
  const admin = await prisma.adminUser.findUnique({
    where: { username }
  });
  if (!admin) {
    throw new AppError("账号或密码错误", 401, 401);
  }

  const matched = await bcrypt.compare(password, admin.passwordHash);
  if (!matched) {
    throw new AppError("账号或密码错误", 401, 401);
  }
  return admin;
}

export async function changeAdminPassword(userId: number, oldPassword: string, newPassword: string) {
  const admin = await prisma.adminUser.findUnique({ where: { id: userId } });
  if (!admin) {
    throw new AppError("Admin user not found", 404, 404);
  }
  const matched = await bcrypt.compare(oldPassword, admin.passwordHash);
  if (!matched) {
    throw new AppError("Old password is incorrect", 400, 400);
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.adminUser.update({
    where: { id: userId },
    data: { passwordHash }
  });
}
