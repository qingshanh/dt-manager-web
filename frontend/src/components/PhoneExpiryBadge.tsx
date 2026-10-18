import React from 'react';
import { Space, Tag } from 'antd';
import dayjs from 'dayjs';

interface PhoneExpiryBadgeProps {
  value: string | number | null | undefined;
  showTag?: boolean;
}

export function parseExpiryTimestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const raw = typeof value === 'string' ? Number(value) : value;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1_000_000_000_000 ? raw : raw * 1000;
  }
  const date = dayjs(value);
  return date.isValid() ? date.valueOf() : null;
}

export function getExpiryStatus(value: string | number | null | undefined) {
  const ms = parseExpiryTimestamp(value);
  if (!ms) {
    return { level: 'unknown' as const, text: '-', color: undefined, tagColor: undefined, remainingText: '' };
  }
  const now = Date.now();
  const diffMs = ms - now;
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  const formattedTime = dayjs(ms).format('YYYY-MM-DD HH:mm');

  if (diffMs <= 0) {
    return {
      level: 'expired' as const,
      text: formattedTime,
      color: '#8c8c8c',
      tagColor: 'default',
      remainingText: '已过期',
      diffDays
    };
  }
  if (diffDays <= 1) {
    const hours = Math.max(1, Math.ceil(diffMs / (60 * 60 * 1000)));
    return {
      level: 'critical' as const, // 1天内 (红)
      text: formattedTime,
      color: '#cf1322',
      tagColor: 'error',
      remainingText: `剩 ${hours} 小时`,
      diffDays
    };
  }
  if (diffDays <= 3) {
    return {
      level: 'warning' as const, // 3天内 (橙)
      text: formattedTime,
      color: '#d46b08',
      tagColor: 'volcano',
      remainingText: `剩 ${Math.ceil(diffDays)} 天`,
      diffDays
    };
  }
  if (diffDays <= 7) {
    return {
      level: 'notice' as const, // 7天内 (黄)
      text: formattedTime,
      color: '#d48806',
      tagColor: 'gold',
      remainingText: `剩 ${Math.ceil(diffDays)} 天`,
      diffDays
    };
  }
  return {
    level: 'normal' as const, // 7天以上 (绿)
    text: formattedTime,
    color: '#389e0d',
    tagColor: 'success',
    remainingText: `剩 ${Math.floor(diffDays)} 天`,
    diffDays
  };
}

export const PhoneExpiryBadge: React.FC<PhoneExpiryBadgeProps> = ({ value, showTag = true }) => {
  const status = getExpiryStatus(value);
  if (status.level === 'unknown') {
    return <span>-</span>;
  }
  return (
    <Space size={4} wrap>
      <span style={{ color: status.color, fontWeight: status.level === 'critical' ? 600 : undefined }}>
        {status.text}
      </span>
      {showTag && (
        <Tag color={status.tagColor} style={{ marginRight: 0, fontWeight: status.level === 'critical' ? 600 : undefined }}>
          {status.remainingText}
        </Tag>
      )}
    </Space>
  );
};
