import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Progress,
  Space,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ShareAltOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  boostAccountGameShare,
  feedAccountPet,
  getAccountGameSummary,
  runAccountGameDaily,
  waterAccountFruit,
  type AccountGameSummary,
  type GameTaskLog,
} from '../../services/endpoints';

interface Props {
  accountId: number;
}

export default function AccountGameRewards({ accountId }: Props) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AccountGameSummary | null>(null);
  const [runningDaily, setRunningDaily] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [logs, setLogs] = useState<GameTaskLog[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const summary = await getAccountGameSummary(accountId);
      setData(summary);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取游戏与福利数据失败');
    } finally {
      setLoading(false);
    }
  }, [accountId, message]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        try {
          textarea.select();
          document.execCommand('copy');
        } finally {
          document.body.removeChild(textarea);
        }
      }
      message.success(`${label}已复制到剪贴板`);
    } catch {
      message.error('复制失败');
    }
  }, [message]);

  const handleRunDaily = async () => {
    setRunningDaily(true);
    try {
      const res = await runAccountGameDaily(accountId);
      setLogs(res.logs);
      if (res.success) {
        message.success('今日日常任务执行完成！');
      } else {
        message.warning('任务执行完毕，部分操作有提示，请查看日志');
      }
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '执行日常失败');
    } finally {
      setRunningDaily(false);
    }
  };

  const handleFeedPet = async () => {
    setActionLoading('feed');
    try {
      const res = await feedAccountPet(accountId);
      setLogs((prev) => [...res.logs, ...prev]);
      message.success('宠物喂食操作已执行');
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '喂食失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleWaterFruit = async () => {
    setActionLoading('water');
    try {
      const res = await waterAccountFruit(accountId);
      setLogs((prev) => [...res.logs, ...prev]);
      message.success('果园浇水操作已执行');
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '浇水失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleShareBoost = async () => {
    setActionLoading('boost');
    try {
      const res = await boostAccountGameShare(accountId);
      if (res.count > 0) {
        message.success(`成功为该账号助力增加 ${res.count} 次游戏机会！`);
      } else {
        message.info(res.logs[res.logs.length - 1] || '助力请求已发送');
      }
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '助力请求失败');
    } finally {
      setActionLoading(null);
    }
  };

  const pet = data?.pet;
  const fruit = data?.fruit;
  const math = data?.mathGame;
  const currentFruit = fruit?.plantFruitList?.[0];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <Space wrap align="center">
          <Typography.Title level={4} style={{ margin: 0 }}>🎮 游戏与福利中心</Typography.Title>
          <Tag color="cyan">客户端: {data?.appType === 0 ? '叮咚 (0)' : '说道 (3)'}</Tag>
        </Space>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadData()}>刷新数据</Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={runningDaily}
            onClick={() => void handleRunDaily()}
          >
            一键执行今日全部日常
          </Button>
        </Space>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {/* 卡片 1: 萌宠工坊 */}
        <Card
          title={(
            <Space>
              <span>🐱 萌宠工坊</span>
              {pet?.petLevel ? <Tag color="gold">Lv.{pet.petLevel}</Tag> : null}
            </Space>
          )}
          extra={
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              loading={actionLoading === 'feed'}
              onClick={() => void handleFeedPet()}
            >
              投喂鱼干
            </Button>
          }
        >
          {pet ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="宠物名称">
                <Typography.Text strong>{pet.petName || '未命名小猫'}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="宠物 ID (petId)">
                <Space size={6}>
                  <Typography.Text copyable={false} strong style={{ color: '#1677ff', fontSize: 15 }}>
                    {pet.petId ?? '-'}
                  </Typography.Text>
                  {pet.petId ? (
                    <Tooltip title="点击复制宠物 ID">
                      <Button
                        size="small"
                        type="text"
                        icon={<CopyOutlined />}
                        onClick={() => void copyText(String(pet.petId), '宠物 ID')}
                      />
                    </Tooltip>
                  ) : null}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="鱼粮余额">
                <Typography.Text type="success" strong>{pet.fishNum ?? 0} g</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="喂食状态">
                {pet.nextFeedRemainingTime === 0 ? (
                  <Tag color="success">可投喂</Tag>
                ) : pet.nextFeedRemainingTime ? (
                  <span>冷却中（剩 {Math.floor(pet.nextFeedRemainingTime / 60)} 分钟）</span>
                ) : (
                  '-'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="寻宝状态">
                {pet.treasureHuntStatus === 0 ? (
                  <Tag color="processing">可出发寻宝</Tag>
                ) : pet.treasureHuntStatus === 1 ? (
                  <Tag color="warning">寻宝中</Tag>
                ) : pet.treasureHuntStatus === 2 ? (
                  <Tag color="success">寻宝完成，可领双倍奖！</Tag>
                ) : (
                  <Tag color="default">寻宝冷却中</Tag>
                )}
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Empty description="暂无宠物数据或未创建宠物" />
          )}
        </Card>

        {/* 卡片 2: 每日果园 */}
        <Card
          title="🍎 每日果园"
          extra={
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              loading={actionLoading === 'water'}
              onClick={() => void handleWaterFruit()}
            >
              浇水一次
            </Button>
          }
        >
          {fruit ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="种植水果">
                <Typography.Text strong>{currentFruit?.name === 'apple' ? '🍎 苹果树' : currentFruit?.name || '未种植'}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="成熟度进度">
                <div style={{ width: '100%', paddingRight: 8 }}>
                  <Progress
                    percent={Math.round((currentFruit?.completionRate ?? 0) * 100)}
                    status={currentFruit && currentFruit.completionRate >= 1 ? 'success' : 'active'}
                  />
                </div>
              </Descriptions.Item>
              <Descriptions.Item label="水滴营养液">
                <Typography.Text strong style={{ color: '#1677ff' }}>{fruit.nutritiveNumber ?? 0} 滴</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="状态与收获">
                {currentFruit && currentFruit.completionRate >= 1 ? (
                  <Tag color="success">已成熟，一键日常可自动收获！</Tag>
                ) : currentFruit ? (
                  <Tag color="blue">生长期</Tag>
                ) : (
                  <Tag color="default">未种植果树</Tag>
                )}
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Empty description="暂无果园数据" />
          )}
        </Card>

        {/* 卡片 3: 算术与不等式挑战 */}
        <Card
          title="🧮 算术不等式挑战"
          extra={
            <Button
              size="small"
              icon={<ShareAltOutlined />}
              loading={actionLoading === 'boost'}
              onClick={() => void handleShareBoost()}
            >
              分享助力加次数
            </Button>
          }
        >
          {math ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="积分余额">
                <Space>
                  <Typography.Text strong style={{ fontSize: 15, color: '#d46b08' }}>
                    {math.validPoint ?? 0}
                  </Typography.Text>
                  {math.expirePoint ? (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      (即将过期: {math.expirePoint})
                    </Typography.Text>
                  ) : null}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="剩余游戏机会">
                <Typography.Text strong>{math.chanceLeft ?? 0} 次</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="看广告可加次数">
                <Tag color={math.watchAdsAddChanceFrequency ? 'green' : 'default'}>
                  {math.watchAdsAddChanceFrequency ?? 0} 次
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="历史最高记录">
                <span>{math.record ? `${math.record} 秒` : '-'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="助力短链码 (shortUuid)">
                <Space size={6}>
                  <Tag color="purple" style={{ fontSize: 13 }}>{math.shortUuid || '未生成'}</Tag>
                  {math.shortUuid ? (
                    <Tooltip title="复制短链链接">
                      <Button
                        size="small"
                        type="text"
                        icon={<CopyOutlined />}
                        onClick={() => {
                          const url = `http://dt-apigatewayv2.dt-pn1.com/game/shareAddChance?shortUuid=${math.shortUuid}`;
                          void copyText(url, '推广助力链接');
                        }}
                      />
                    </Tooltip>
                  ) : null}
                </Space>
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Empty description="暂无算术游戏数据" />
          )}
        </Card>
      </div>

      {/* 实时执行日志 */}
      {logs.length > 0 && (
        <Card title="📋 任务执行日志" size="small" extra={<Button size="small" type="link" onClick={() => setLogs([])}>清空日志</Button>}>
          <Timeline
            style={{ marginTop: 12 }}
            items={logs.map((log, index) => {
              const color =
                log.level === 'success'
                  ? 'green'
                  : log.level === 'warn'
                  ? 'orange'
                  : log.level === 'error'
                  ? 'red'
                  : 'blue';
              return {
                key: index,
                color,
                children: (
                  <Space size={8}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>[{log.time}]</Typography.Text>
                    <Tag style={{ fontSize: 11, marginInlineEnd: 0 }}>{log.module.toUpperCase()}</Tag>
                    <Typography.Text type={log.level === 'error' ? 'danger' : undefined}>
                      {log.message}
                    </Typography.Text>
                  </Space>
                ),
              };
            })}
          />
        </Card>
      )}
    </Space>
  );
}