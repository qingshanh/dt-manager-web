import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  InputNumber,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import {
  ClockCircleOutlined,
  CopyOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ShareAltOutlined,
  StarOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import {
  boostAccountGameShare,
  feedAccountPet,
  getAccountGameSummary,
  getGameRankList,
  climbAccountMathRank,
  redeemMathGamePoints,
  runAccountGameDaily,
  runAccountKnifeDaily,
  runAllAccountsGameDaily,
  waterAccountFruit,
  runAccountMemberDaily,
  runAccountFreeCreditsDaily,
  getMathSecondaryChannel,
  setMathSecondaryChannel,
  runAccountMathDaily,
  getAutoRedeemAmazon,
  setAutoRedeemAmazon,
  getAccountPointStore,
  getGameSchedulerStatus,
  type AccountGameSummary,
  type GameTaskLog,
  type RankLeaderboardItem,
} from '../../services/endpoints';

interface Props {
  accountId: number;
}

export default function AccountGameRewards({ accountId }: Props) {
  const { message, modal } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AccountGameSummary | null>(null);
  const [runningDaily, setRunningDaily] = useState(false);
  const [runningAllDaily, setRunningAllDaily] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [logs, setLogs] = useState<GameTaskLog[]>([]);
  const navigate = useNavigate();
  const [autoRedeemAmazon, setAutoRedeemAmazonState] = useState(false);
  const [autoRedeemTarget, setAutoRedeemTarget] = useState('');
  const [savingAutoRedeem, setSavingAutoRedeem] = useState(false);
  const [pointStoreData, setPointStoreData] = useState<any>(null);
  const [schedulerStatus, setSchedulerStatus] = useState<any>(null);
  const [secondaryChannelEnabled, setSecondaryChannelEnabled] = useState(false);
  const [savingSecondaryChannel, setSavingSecondaryChannel] = useState(false);

  // Modals state
  const [climbModalOpen, setClimbModalOpen] = useState(false);
  const [targetRankChoice, setTargetRankChoice] = useState<number>(0);
  const [customScoreInput, setCustomScoreInput] = useState<number>(430);
  const [selectedRankAppId, setSelectedRankAppId] = useState<number>(66);
  const [guideModalOpen, setGuideModalOpen] = useState(false);
  const [guideTab, setGuideTab] = useState('pet');
  const [rankModalOpen, setRankModalOpen] = useState(false);
  const [rankLoading, setRankLoading] = useState(false);
  const [rankList, setRankList] = useState<RankLeaderboardItem[]>([]);
  const [memberHistoryModalOpen, setMemberHistoryModalOpen] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const summary = await getAccountGameSummary(accountId);
      setData(summary);
      void getAutoRedeemAmazon(accountId).then((res) => { setAutoRedeemAmazonState(res.enabled); if (res.target_product) setAutoRedeemTarget(res.target_product); }).catch(() => {});
      void getAccountPointStore(accountId).then((res) => {
        setPointStoreData(res);
        if (!autoRedeemTarget && res?.products?.[0]?.product_id) {
          setAutoRedeemTarget(String(res.products[0].product_id));
        }
      }).catch(() => {});
      void getMathSecondaryChannel(accountId).then((res) => setSecondaryChannelEnabled(res.enabled)).catch(() => {});
      void getGameSchedulerStatus().then((res) => setSchedulerStatus(res)).catch(() => {});
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
        message.warning('任务执行完毕，请查看日志提示');
      }
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '执行日常失败');
    } finally {
      setRunningDaily(false);
    }
  };

  const handleRunAllDaily = () => {
    modal.confirm({
      title: '确认一键执行全部账户日常任务？',
      content: '后台将自动按顺序为你的全部账户打卡（各账号间隔3秒平滑错峰），并共享宠物互助池。',
      okText: '开始执行',
      cancelText: '取消',
      onOk: async () => {
        setRunningAllDaily(true);
        try {
          const res = await runAllAccountsGameDaily();
          message.success(`已为全部 ${res.total} 个账户完成日常打卡！`);
          await loadData();
        } catch (err) {
          message.error(err instanceof Error ? err.message : '批量打卡失败');
        } finally {
          setRunningAllDaily(false);
        }
      },
    });
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



  const handleToggleAutoRedeemAmazon = async (checked: boolean, target = autoRedeemTarget) => {
    setSavingAutoRedeem(true);
    try {
      const res = await setAutoRedeemAmazon(accountId, checked, target);
      setAutoRedeemAmazonState(res.enabled);
      if (res.target_product) setAutoRedeemTarget(res.target_product);
      message.success(res.enabled ? '已开启积分年底到期自动兑换' : '已关闭自动兑换');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存设置失败');
    } finally {
      setSavingAutoRedeem(false);
    }
  };

  const handleSaveAutoRedeemTarget = async () => {
    await handleToggleAutoRedeemAmazon(autoRedeemAmazon, autoRedeemTarget);
    message.success('已保存自动兑换目标商品配置！');
  };

  const handleToggleSecondaryChannel = async (checked: boolean) => {
    setSavingSecondaryChannel(true);
    try {
      const res = await setMathSecondaryChannel(accountId, checked);
      setSecondaryChannelEnabled(res.enabled);
      message.success(res.enabled ? '已开启算术副通道全自动任务（做题/看广告/自动兑换）' : '已关闭算术副通道任务');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存副通道设置失败');
    } finally {
      setSavingSecondaryChannel(false);
    }
  };

  const handleRunFreeCredits = async () => {
    setActionLoading('free-credits');
    try {
      const res = await runAccountFreeCreditsDaily(accountId);
      if (res.logs?.length) {
        setLogs((prev) => [...res.logs, ...prev]);
      }
      if (res.totalCreditsWon > 0) {
        message.success(`【获取免费币】每日签到与幸运测试成功获得 ${res.totalCreditsWon} 币！`);
      } else {
        message.info('【获取免费币】每日签到与幸运测试已执行完成');
      }
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取免费币执行失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRunMathDaily = async () => {
    setActionLoading('math');
    try {
      const res = await runAccountMathDaily(accountId);
      if (res.logs) {
        setLogs((prev) => [...res.logs, ...prev]);
      }
      if (res.success) {
        message.success('算术不等式自动做题与冲榜已完成！');
      } else {
        message.info('算术日常任务已处理');
      }
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '算术日常执行失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleClimbRank = async () => {
    setActionLoading('climb');
    setClimbModalOpen(false);
    try {
      const params: { target_rank?: number; custom_score?: number } = {};
      if (targetRankChoice === -1) {
        params.custom_score = customScoreInput;
      } else if (targetRankChoice >= 2 && targetRankChoice <= 6) {
        params.target_rank = targetRankChoice;
      }
      const res = await climbAccountMathRank(accountId, params);
      if (res.logs?.length) {
        setLogs((prev) => [...res.logs, ...prev]);
      }
      if (res.success) {
        message.success(res.message || '冲榜挑战成功！');
      } else {
        message.info(res.message || '冲榜挑战已处理');
      }
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '冲榜挑战失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRunMemberDaily = async () => {
    setActionLoading('member');
    try {
      const res = await runAccountMemberDaily(accountId);
      setLogs((prev) => [...res.logs, ...prev]);
      message.success('会员签到与好运抽奖已执行完成！');
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '会员任务执行失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRunKnife = async () => {
    setActionLoading('knife');
    try {
      const res = await runAccountKnifeDaily(accountId);
      setLogs((prev) => [...res.logs, ...prev]);
      message.success('飞刀国王日常操作已执行');
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '飞刀操作失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRedeemPoints = async (productId: number, prodName: string) => {
    setActionLoading(`redeem-${productId}`);
    try {
      const res = await redeemMathGamePoints(accountId, productId);
      if (res.success) {
        message.success(res.message);
      } else {
        message.warning(res.message);
      }
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : `兑换【${prodName}】失败`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleShareBoost = async (targetUuid?: string, actionKey = 'boost') => {
    setActionLoading(actionKey);
    try {
      const res = await boostAccountGameShare(accountId, targetUuid);
      if (res.count > 0) {
        message.success(`成功为该账号助力增加 ${res.count} 次游戏机会！`);
      } else {
        message.info(res.logs[res.logs.length - 1] || '助力请求已处理');
      }
      await loadData();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '助力请求失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleOpenRank = async (targetAppId?: number) => {
    const appIdToQuery = targetAppId || data?.gameAppId || 66;
    setSelectedRankAppId(appIdToQuery);
    setRankModalOpen(true);
    setRankLoading(true);
    try {
      const list = await getGameRankList(appIdToQuery);
      setRankList(list);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取排行榜失败');
    } finally {
      setRankLoading(false);
    }
  };

  const openGuide = (tab: string) => {
    setGuideTab(tab);
    setGuideModalOpen(true);
  };

  const pet = data?.pet;
  const fruit = data?.fruit;
  const knife = data?.knife;
  const math = data?.mathGame;
  const member = data?.member;
  const currentFruit = fruit?.plantFruitList?.[0];
  const expiry = data?.creditExpiry;

  const formatRemainingDuration = (seconds?: number | null): string => {
    if (!seconds || seconds <= 0) return '即将结算';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}天 ${h}小时 ${m}分`;
    if (h > 0) return `${h}小时 ${m}分`;
    return `${m}分钟`;
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 顶部状态与全局控制条 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <Space wrap align="center">
          <Typography.Title level={4} style={{ margin: 0 }}>🎮 游戏与福利自动化中心</Typography.Title>
          <Tag color="cyan">客户端: {data?.appType === 0 ? '叮咚 (0)' : '说道 (3)'}</Tag>
        </Space>
        <Space wrap align="center">
          {schedulerStatus?.running ? (
            <Tag color="processing" icon={<ReloadOutlined spin />}>
              正在自动调度: {schedulerStatus.currentTask || '任务执行中'}
            </Tag>
          ) : schedulerStatus?.nextCycleAt ? (
            <Tag color="blue" icon={<ClockCircleOutlined />}>
              下次自动唤醒: {new Date(schedulerStatus.nextCycleAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </Tag>
          ) : null}
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadData()}>刷新数据</Button>
          <Button
            icon={<ThunderboltOutlined />}
            loading={runningAllDaily}
            onClick={handleRunAllDaily}
          >
            一键完成所有账号全部任务
          </Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={runningDaily}
            onClick={() => void handleRunDaily()}
          >
            一键执行此账号今日全部日常
          </Button>
        </Space>
      </div>

      {/* 会员积分年底到期提醒 (仅在当年有积分到期时单行展示) */}
      {expiry && typeof expiry.expireCredit === 'number' && expiry.expireCredit > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ padding: '6px 16px', borderRadius: 6, fontSize: 13 }}
          message={
            <span>
              🌟 <Typography.Text strong>积分年底到期提醒</Typography.Text>：当前账户有 <Typography.Text strong type="danger">{expiry.expireCredit}</Typography.Text> 积分将于 {expiry.expireDate || '年底'} 到期，请及时兑换！(说道币/叮咚币为钱包余额永久有效)
            </span>
          }
        />
      ) : null}

      {/* 4 大游戏功能卡片网格 */}
      <style>{`
        .game-cards-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 16px;
          width: 100%;
          max-width: 100%;
        }
        @media (max-width: 1280px) {
          .game-cards-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 768px) {
          .game-cards-grid {
            grid-template-columns: minmax(0, 1fr) !important;
            gap: 12px;
            width: 100% !important;
            max-width: 100% !important;
          }
          .ant-card {
            width: 100% !important;
            max-width: 100% !important;
            overflow: hidden !important;
          }
          .ant-card-body {
            padding: 12px 10px !important;
          }
          .ant-descriptions {
            width: 100% !important;
          }
          .ant-descriptions-view {
            width: 100% !important;
            table-layout: fixed !important;
          }
          .ant-descriptions-item-label {
            width: 96px !important;
            min-width: 96px !important;
            max-width: 96px !important;
            padding: 6px 8px !important;
            font-size: 12px !important;
          }
          .ant-descriptions-item-content {
            padding: 6px 8px !important;
            font-size: 12px !important;
            word-break: break-all !important;
            overflow-wrap: anywhere !important;
          }
        }
      `}</style>
      <div className="game-cards-grid">
        {/* 卡片 1: 萌宠工坊 (Pet) */}
        <Card
          title={(
            <Space>
              <span>🐱 萌宠工坊</span>
              {pet?.petLevel ? <Tag color="gold">Lv.{pet.petLevel}</Tag> : null}
            </Space>
          )}
          extra={(
            <Space size={6}>
              <Tooltip title="查看玩法说明"><Button size="small" type="text" icon={<InfoCircleOutlined />} onClick={() => openGuide('pet')} /></Tooltip>
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                loading={actionLoading === 'feed'}
                onClick={() => void handleFeedPet()}
              >
                投喂鱼干
              </Button>
            </Space>
          )}
        >
          {pet ? (
            <Descriptions size="small" column={1} bordered labelStyle={{ width: '115px', minWidth: '95px', whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 500 }} contentStyle={{ wordBreak: 'break-all' }}>
              <Descriptions.Item label="宠物名称">
                <Typography.Text strong>{pet.petName || '未命名小猫'}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="成长进度">
                <div style={{ width: '100%', paddingRight: 8 }}>
                  <Progress
                    percent={Math.round((pet.growthRate ?? 0) * 100)}
                    format={() => `${pet.growthValue ?? 0}/${(pet.growthValue ?? 0) + (pet.nextLevelRequiredGrowthValue ?? 0)}`}
                  />
                </div>
              </Descriptions.Item>
              <Descriptions.Item label="宠物专属 ID (petId)">
                <Space size={6}>
                  <Typography.Text copyable={false} strong style={{ color: '#1677ff', fontSize: 15 }}>
                    {pet.petId ?? '-'}
                  </Typography.Text>
                  {pet.petId ? (
                    <Tooltip title="点击复制宠物 ID (用于多号互助)">
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
                <Typography.Text strong style={{ color: '#52c41a' }}>{pet.fishNum ?? 0} g</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="喂食状态">
                {pet.nextFeedRemainingTime === 0 ? (
                  <Tag color="success">饥饿中，可立即投喂！</Tag>
                ) : pet.nextFeedRemainingTime ? (
                  <span>饱腹冷却中（剩 {Math.floor(pet.nextFeedRemainingTime / 60)} 分钟）</span>
                ) : (
                  '-'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="寻宝状态">
                {pet.treasureHuntStatus === 0 ? (
                  <Tag color="processing">未寻宝，自动日常可立即出发</Tag>
                ) : pet.treasureHuntStatus === 1 ? (
                  <Tag color="warning">寻宝中（剩 {Math.floor((pet.treasureHuntEndRemainingTime || 0) / 60)} 分钟）</Tag>
                ) : pet.treasureHuntStatus === 2 ? (
                  <Tag color="success">寻宝完成！自动日常可领双倍奖并进入下一次</Tag>
                ) : (
                  <Tag color="default">寻宝冷却中</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="每日任务与玩耍">
                <Space wrap size={[4, 4]} style={{ marginTop: 2 }}>
                  <Tag color={pet.lotteryLeftChance > 0 ? 'orange' : 'default'}>转盘: {pet.lotteryLeftChance}次可用</Tag>
                  <Tag color={pet.playLeftChance > 0 ? 'purple' : 'default'}>玩耍: {pet.playLeftChance}次可用</Tag>
                  {pet.tasks?.map((t) => (
                    <Tag key={t.taskType} color={t.isFinished ? 'green' : 'blue'}>
                      {t.taskName}: {t.completed}/{t.total}
                    </Tag>
                  ))}
                </Space>
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Empty description="暂无宠物数据或未创建宠物" />
          )}
        </Card>

        {/* 卡片 2: 每日果园 (Fruit) */}
        <Card
          title="🍎 每日果园"
          extra={(
            <Space size={6}>
              <Tooltip title="查看玩法说明"><Button size="small" type="text" icon={<InfoCircleOutlined />} onClick={() => openGuide('fruit')} /></Tooltip>
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                disabled={Boolean(fruit?.isDailyWaterLimitReached)}
                loading={actionLoading === 'water'}
                onClick={() => void handleWaterFruit()}
              >
                {fruit?.isDailyWaterLimitReached ? '已达上限' : '浇水'}
              </Button>
            </Space>
          )}
        >
          {fruit ? (
            <Descriptions size="small" column={1} bordered labelStyle={{ width: '115px', minWidth: '95px', whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 500 }} contentStyle={{ wordBreak: 'break-all' }}>
              <Descriptions.Item label="种植水果">
                <Typography.Text strong>{currentFruit?.name === 'apple' ? '🍎 苹果树 (最高收益推荐)' : currentFruit?.name || '未种植(自动种苹果)'}</Typography.Text>
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
              <Descriptions.Item label="果树状态">
                {currentFruit && currentFruit.completionRate >= 1 ? (
                  <Tag color="success">已成熟！自动日常可自动收获说道币</Tag>
                ) : fruit?.isDailyWaterLimitReached ? (
                  <Tag color="warning">生长期 (今日浇水已达官方上限，次日刷新)</Tag>
                ) : currentFruit ? (
                  <Tag color="blue">生长期（有水滴将自动浇水）</Tag>
                ) : (
                  <Tag color="default">未种植果树</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="水滴任务进度">
                <Space wrap size={[4, 4]}>
                  {fruit.tasks?.map((t) => (
                    <Tag key={t.taskType} color={t.isFinished ? 'green' : 'blue'}>
                      {t.taskName}: {t.completed}/{t.total}
                    </Tag>
                  ))}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="历史收成记录 (永久保存)">
                {fruit.harvestHistory && fruit.harvestHistory.length > 0 ? (
                  <div style={{ maxHeight: 75, overflowY: 'auto' }}>
                    {fruit.harvestHistory.slice(0, 3).map((h, i) => (
                      <div key={i} style={{ fontSize: 12 }}>
                        <Tag color="green" style={{ marginInlineEnd: 4 }}>+{h.creditsWon} 币</Tag>
                        <span>{h.fruitName} ({new Date(h.harvestedAt).toLocaleDateString()})</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>果实成熟后会自动收取并永久留存收成记录</Typography.Text>
                )}
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Empty description="暂无果园数据" />
          )}
        </Card>

        {/* 卡片 3: 飞刀国王 (Knife King) */}
        <Card
          title="🗡️ 飞刀国王"
          extra={(
            <Space size={6}>
              <Tooltip title="查看玩法说明"><Button size="small" type="text" icon={<InfoCircleOutlined />} onClick={() => openGuide('knife')} /></Tooltip>
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                loading={actionLoading === 'knife'}
                onClick={() => void handleRunKnife()}
              >
                执行飞刀
              </Button>
            </Space>
          )}
        >
          {knife ? (
            <Descriptions size="small" column={1} bordered labelStyle={{ width: '115px', minWidth: '95px', whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 500 }} contentStyle={{ wordBreak: 'break-all' }}>
              <Descriptions.Item label="果汁金币">
                <Typography.Text strong style={{ color: '#d46b08', fontSize: 15 }}>{knife.fruitJuiceAmount ?? 0}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="剩余游戏机会">
                <Typography.Text strong>{knife.remainPlayTimes ?? 0} 次</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="看广告拿次数">
                <Tag color={knife.watchingGetPlayTimes < knife.watchingGetPlayTimesLimit ? 'processing' : 'default'}>
                  已获取 {knife.watchingGetPlayTimes} / 上限 {knife.watchingGetPlayTimesLimit} 次
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="宝箱状态">
                {knife.canOpenTreasureBox ? (
                  <Tag color="success">宝箱已就绪，日常自动开启！</Tag>
                ) : knife.treasureBoxOpenTime ? (
                  <span>开启时间：{new Date(knife.treasureBoxOpenTime).toLocaleString()}</span>
                ) : (
                  <Tag color="default">未拥有宝箱</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="自动飞刀机制">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  日常执行时自动看广告拿满 15 次机会，自动投掷飞刀并触发十级轮盘抽奖翻倍！
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Empty description="暂无飞刀游戏数据" />
          )}
        </Card>

        {/* 卡片 4: 算术与不等式挑战 (Math Game) */}
        <Card
          title="🧮 算术挑战"
          extra={(
            <Space size={4} wrap>
              <Tooltip title="查看玩法说明"><Button size="small" type="text" icon={<InfoCircleOutlined />} onClick={() => openGuide('math')} /></Tooltip>
              <Button size="small" icon={<TrophyOutlined />} onClick={() => void handleOpenRank()}>排行榜</Button>
              <Button size="small" icon={<ThunderboltOutlined />} loading={actionLoading === 'math'} onClick={() => void handleRunMathDaily()}>做题</Button>
              <Button size="small" type="primary" icon={<TrophyOutlined />} loading={actionLoading === 'climb'} onClick={() => setClimbModalOpen(true)}>冲榜</Button>
            </Space>
          )}
        >
          {math ? (
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {/* 核心指标统计仪表盘 */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 8,
                  background: '#fafafa',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid #f0f0f0'
                }}
              >
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>积分余额</Typography.Text>
                  <div>
                    <Typography.Text strong style={{ fontSize: 18, color: '#d46b08' }}>
                      {math.validPoint ?? 0}
                    </Typography.Text>
                    {math.expirePoint ? (
                      <Typography.Text type="danger" style={{ fontSize: 11, marginLeft: 4 }}>
                        (将过期: {math.expirePoint})
                      </Typography.Text>
                    ) : null}
                  </div>
                </div>

                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>剩余答题机会</Typography.Text>
                  <div>
                    <Typography.Text strong style={{ fontSize: 16 }}>
                      {math.chanceLeft ?? 0} 次
                    </Typography.Text>
                    {math.watchAdsAddChanceFrequency ? (
                      <Tag color="green" style={{ marginLeft: 4, fontSize: 11, padding: '0 4px' }}>
                        广告+{math.watchAdsAddChanceFrequency}
                      </Tag>
                    ) : null}
                  </div>
                </div>

                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>世界排名 / 战绩</Typography.Text>
                  <div>
                    {typeof math.ranking === 'number' && math.ranking > 0 ? (
                      <Tag color={math.ranking <= 10 ? 'gold' : 'blue'} style={{ margin: 0, fontWeight: 'bold' }}>
                        🏆 #{math.ranking} ({math.bestScore ?? 0}分)
                      </Tag>
                    ) : (
                      <Tag color="default" style={{ margin: 0 }}>未上榜</Tag>
                    )}
                  </div>
                </div>

                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>本轮赛季结算</Typography.Text>
                  <div>
                    {math.seasonEndAt ? (
                      <Tooltip title={`${new Date(math.seasonEndAt).toLocaleDateString('zh-CN')} ${new Date(math.seasonEndAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 结算`}>
                        <Tag color="orange" style={{ margin: 0, cursor: 'pointer' }}>
                          剩 {formatRemainingDuration(math.seasonRemainingSeconds)}
                        </Tag>
                      </Tooltip>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>进行中</Typography.Text>
                    )}
                  </div>
                </div>
              </div>

              {/* 详细配置与操作列表 */}
              <Descriptions
                size="small"
                column={1}
                bordered
                labelStyle={{ width: '115px', minWidth: '95px', whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 500 }}
                contentStyle={{ wordBreak: 'break-all' }}
              >
                <Descriptions.Item label="副通道自动化">
                  <Space wrap align="center" size={8}>
                    <Switch
                      checked={secondaryChannelEnabled}
                      loading={savingSecondaryChannel}
                      onChange={(checked) => void handleToggleSecondaryChannel(checked)}
                      checkedChildren="开"
                      unCheckedChildren="关"
                    />
                    <Typography.Text style={{ fontSize: 12, color: secondaryChannelEnabled ? '#1677ff' : '#888' }}>
                      {secondaryChannelEnabled ? '已开启：自动做题翻倍+自动兑换充入主钱包' : '默认关闭（防风控，仅保留副短链供手动使用）'}
                    </Typography.Text>
                  </Space>
                </Descriptions.Item>

                <Descriptions.Item label="推广短链码">
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space wrap size={[8, 8]}>
                    {/* 叮咚短链码 */}
                    {math.shortUuidDingdong ? (
                      <Space size={4} align="center" style={{ background: '#f0f5ff', padding: '3px 8px', borderRadius: 6, border: '1px solid #adc6ff' }}>
                        <Tag color="blue" style={{ fontSize: 13, margin: 0 }}>
                          叮咚: <strong>{math.shortUuidDingdong}</strong>
                        </Tag>
                        <Tooltip title="复制叮咚推广链接">
                          <Button
                            size="small"
                            type="text"
                            icon={<CopyOutlined />}
                            onClick={() => {
                              const url = `http://dt-apigatewayv2.dt-pn1.com/game/shareAddChance?shortUuid=${math.shortUuidDingdong}`;
                              void copyText(url, '叮咚推广短链');
                            }}
                          />
                        </Tooltip>
                        <Tag color={math.shareBoostToday?.isMaxReached66 ? 'default' : 'cyan'} style={{ margin: 0 }}>
                          +{math.shareBoostToday?.count66 ?? 0}次{math.shareBoostToday?.isMaxReached66 ? '(满)' : ''}
                        </Tag>
                        <Button
                          size="small"
                          disabled={math.shareBoostToday?.isMaxReached66}
                          loading={actionLoading === 'boost-66'}
                          onClick={() => void handleShareBoost(math.shortUuidDingdong || undefined, 'boost-66')}
                        >
                          仅助叮咚
                        </Button>
                      </Space>
                    ) : null}

                    {/* 说道短链码 */}
                    {math.shortUuidShuodao ? (
                      <Space size={4} align="center" style={{ background: '#f9f0ff', padding: '3px 8px', borderRadius: 6, border: '1px solid #d3adf7' }}>
                        <Tag color="purple" style={{ fontSize: 13, margin: 0 }}>
                          说道: <strong>{math.shortUuidShuodao}</strong>
                        </Tag>
                        <Tooltip title="复制说道推广链接">
                          <Button
                            size="small"
                            type="text"
                            icon={<CopyOutlined />}
                            onClick={() => {
                              const url = `http://dt-apigatewayv2.dt-pn1.com/game/shareAddChance?shortUuid=${math.shortUuidShuodao}`;
                              void copyText(url, '说道推广短链');
                            }}
                          />
                        </Tooltip>
                        <Tag color={math.shareBoostToday?.isMaxReached67 ? 'default' : 'purple'} style={{ margin: 0 }}>
                          +{math.shareBoostToday?.count67 ?? 0}次{math.shareBoostToday?.isMaxReached67 ? '(满)' : ''}
                        </Tag>
                        <Button
                          size="small"
                          disabled={math.shareBoostToday?.isMaxReached67}
                          loading={actionLoading === 'boost-67'}
                          onClick={() => void handleShareBoost(math.shortUuidShuodao || undefined, 'boost-67')}
                        >
                          仅助说道
                        </Button>
                      </Space>
                    ) : null}

                    {/* 降级回退单一短链码 */}
                    {!math.shortUuidDingdong && !math.shortUuidShuodao && math.shortUuid && (
                      <Space size={4}>
                        <Tag color="purple">{math.shortUuid}</Tag>
                        <Tooltip title="复制推广链接">
                          <Button
                            size="small"
                            type="text"
                            icon={<CopyOutlined />}
                            onClick={() => {
                              const url = `http://dt-apigatewayv2.dt-pn1.com/game/shareAddChance?shortUuid=${math.shortUuid}`;
                              void copyText(url, '推广短链');
                            }}
                          />
                        </Tooltip>
                      </Space>
                    )}
                  </Space>

                  {/* 双通道一键全量换IP助力 */}
                  <div>
                    <Button
                      size="small"
                      type="dashed"
                      icon={<ShareAltOutlined />}
                      disabled={math.shareBoostToday?.isMaxReached66 && math.shareBoostToday?.isMaxReached67}
                      loading={actionLoading === 'boost-all'}
                      onClick={() => void handleShareBoost(undefined, 'boost-all')}
                    >
                      ⚡ 一键双通道换IP助力 (今日总助力: +{math.shareBoostToday?.count ?? 0} 次)
                    </Button>
                  </div>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="积分额度兑换 (每日限1次)">
                <Space wrap size={6}>
                  {math.redeemProducts?.map((p) => {
                    const isRedeemed = math.redeemedTodayProductIds?.includes(p.productId);
                    return (
                      <Button
                        key={p.productId}
                        size="small"
                        disabled={isRedeemed || (math.validPoint ?? 0) < p.price}
                        loading={actionLoading === `redeem-${p.productId}`}
                        onClick={() => void handleRedeemPoints(p.productId, p.productName)}
                      >
                        {isRedeemed ? `今日已兑换 (${p.price}分)` : `兑换 ${p.price}分 (剩${p.stock})`}
                      </Button>
                    );
                  })}
                  {(!math.redeemProducts || math.redeemProducts.length === 0) && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>支持 1,000分与 10,000分兑换说道币/叮咚币 (每日各限1次)</Typography.Text>
                  )}
                </Space>
              </Descriptions.Item>
            </Descriptions>
            </Space>
          ) : (
            <Empty description="暂无算术游戏数据" />
          )}
        </Card>
        {/* 卡片 5: 会员好运与每日签到 (Member & Roulette) */}
        <Card
          title="🌟 会员好运签到"
          extra={(
            <Space size={6}>
              <Button size="small" type="primary" loading={actionLoading === 'free-credits'} onClick={() => void handleRunFreeCredits()}>免费币签到/测试</Button>
              <Button size="small" icon={<ClockCircleOutlined />} onClick={() => setMemberHistoryModalOpen(true)}>历史</Button>
              <Button size="small" icon={<StarOutlined />} loading={actionLoading === 'member'} onClick={() => void handleRunMemberDaily()}>签到抽奖</Button>
            </Space>
          )}
        >
          <Descriptions size="small" column={1} bordered labelStyle={{ width: '115px', minWidth: '95px', whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 500 }} contentStyle={{ wordBreak: 'break-all' }}>
            <Descriptions.Item label="🎁 免费币签到 & 幸运测试">
              <Space wrap align="center" size={8}>
                <Tag color="cyan">每日免费币签到</Tag>
                <Tag color="gold">幸运测试 (Feeling Lucky)</Tag>
                <Button
                  size="small"
                  loading={actionLoading === 'free-credits'}
                  onClick={() => void handleRunFreeCredits()}
                >
                  立即领币
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  实打实获得说道/叮咚币直充主钱包余额
                </Typography.Text>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="每日好运转盘">
              <Space wrap size={[4, 4]}>
                <Tag color={member && member.adRouletteRemainTimes > 0 ? 'orange' : 'default'}>
                  可用抽奖: {member?.adRouletteRemainTimes ?? 0} 次
                </Tag>
                <Tag color="blue">
                  广告加抽奖: 每日看广告 +2 次
                </Tag>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="会员每日签到">
              <Space wrap size={[4, 4]}>
                <Tag color={member && member.validTimes > 0 ? 'green' : 'default'}>
                  签到状态: {member && member.validTimes > 0 ? `可签到 (${member.validTimes}次)` : '今日已签到'}
                </Tag>
                <Tag color="cyan">
                  加赠任务: {member ? `${member.addTimes} / ${member.maxAddTimes}` : '0 / 2'}
                </Tag>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="最近中奖奖励">
              {member?.lastReward ? (
                <Space>
                  <Tag color="success" style={{ fontSize: 13, padding: '2px 8px' }}>
                    🎉 {member.lastReward}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    (已持久化存档)
                  </Typography.Text>
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  执行签到或好运转盘后将自动展示最新奖品并存档
                </Typography.Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="历史中奖记录 (永久保存)">
              {member?.history && member.history.length > 0 ? (
                <div style={{ maxHeight: 75, overflowY: 'auto' }}>
                  {member.history.slice(0, 3).map((h, i) => (
                    <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>
                      <Tag color="purple" style={{ marginInlineEnd: 4 }}>{h.sourceName}</Tag>
                      <Typography.Text strong style={{ color: '#d46b08' }}>{h.prizeName}</Typography.Text>
                      <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 11 }}>
                        ({new Date(h.receivedAt).toLocaleDateString()})
                      </Typography.Text>
                    </div>
                  ))}
                </div>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  暂无历史奖励记录，点击「签到/抽奖」或运行全量日常即可触发
                </Typography.Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="全自动执行机制">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                日常自动调度时自动看广告拿满 2 次好运抽奖，自动完成签到领奖，所有中奖均留存本地可追溯！
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>
        </Card>

        {/* 卡片 6: 会员积分商城与自动兑换 (Point Store & Amazon Auto Redeem) */}
        <Card
          title="🎁 积分商城"
          extra={(
            <Space size={6}>
              <Button
                size="small"
                type="primary"
                onClick={() => navigate(`/accounts/${accountId}/point-store`)}
              >
                进入商城
              </Button>
            </Space>
          )}
        >
          <Descriptions size="small" column={1} bordered labelStyle={{ width: '115px', minWidth: '95px', whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 500 }} contentStyle={{ wordBreak: 'break-all' }}>
            <Descriptions.Item label="积分总览">
              <Space wrap size={[8, 4]}>
                <span>可用: <Typography.Text strong style={{ color: '#d46b08', fontSize: 14 }}>{pointStoreData?.valid_point ?? math?.validPoint ?? 0}</Typography.Text></span>
                <span>历史: <Typography.Text strong>{pointStoreData?.history_point ?? 0}</Typography.Text></span>
                <span>年底到期: <Typography.Text strong type={expiry?.expireCredit ? 'danger' : undefined}>{expiry?.expireCredit ?? pointStoreData?.expire_point ?? 0}</Typography.Text></span>
              </Space>
            </Descriptions.Item>

            <Descriptions.Item label="自动兑换配置">
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Typography.Text strong>
                    积分到期自动兑换
                  </Typography.Text>
                  <Switch
                    checked={autoRedeemAmazon}
                    loading={savingAutoRedeem}
                    onChange={(checked) => void handleToggleAutoRedeemAmazon(checked, autoRedeemTarget)}
                    checkedChildren="开启"
                    unCheckedChildren="关闭"
                  />
                </Space>
                <Space wrap style={{ width: '100%', gap: 6 }}>
                  <span style={{ fontSize: 12, color: '#555' }}>目标:</span>
                  <Select
                    showSearch
                    style={{ minWidth: 200, flex: 1 }}
                    placeholder="选择或输入商品 ID / 名称"
                    value={autoRedeemTarget || undefined}
                    onChange={(val) => setAutoRedeemTarget(val)}
                    options={(pointStoreData?.products ?? []).map((p: any) => ({
                      value: String(p.product_id),
                      label: `[ID: ${p.product_id}] ${p.name} (${p.price}分)`
                    }))}
                  />
                  <Button size="small" type="primary" loading={savingAutoRedeem} onClick={handleSaveAutoRedeemTarget}>
                    保存
                  </Button>
                </Space>
                <div style={{ fontSize: 11, color: '#888', lineHeight: 1.4 }}>
                  触发规则：①开启开关；②积分充足；③当年有积分要过期且距离到期 &le; 30天；④商品有货。满足时自动下单并电报通知。
                </div>
              </Space>
            </Descriptions.Item>

            <Descriptions.Item label="商城商品 (点击选中)">
              <Space wrap size={6}>
                {pointStoreData?.products?.map((p: any) => (
                  <Button
                    key={p.product_id}
                    size="small"
                    disabled={(pointStoreData?.valid_point ?? 0) < (p.price ?? 0)}
                    onClick={() => {
                      setAutoRedeemTarget(String(p.product_id));
                      message.info(`已选中目标商品 [ID: ${p.product_id}] ${p.name}`);
                    }}
                  >
                    [ID: {p.product_id}] {p.name} ({p.price}分)
                  </Button>
                ))}
                {(!pointStoreData?.products || pointStoreData.products.length === 0) && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    暂无商品，点击右上角进入商城
                  </Typography.Text>
                )}
              </Space>
            </Descriptions.Item>
          </Descriptions>
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

      {/* 游戏说明 Modal */}
      <Modal
        title="📖 说道 / 叮咚 游戏玩法与收益说明"
        open={guideModalOpen}
        onCancel={() => setGuideModalOpen(false)}
        footer={null}
        width={720}
      >
        <Tabs
          activeKey={guideTab}
          onChange={setGuideTab}
          items={[
            {
              key: 'pet',
              label: '🐱 萌宠工坊',
              children: (
                <div style={{ lineHeight: 1.8 }}>
                  <Typography.Paragraph strong>【玩法与机制】</Typography.Paragraph>
                  <p>1. <strong>喂食小猫</strong>：消耗鱼粮（50g/10g/5g/2g）。每次喂食增加成长值并使小猫进入饱腹状态，冷却结束后再次进入饥饿状态，面板会自动在饥饿时投喂。</p>
                  <p>2. <strong>寻宝赚钱</strong>：小猫未寻宝时会自动出发寻宝；寻宝归来可获得说道币/叮咚币或鱼粮奖励，面板会自动触发双倍领奖并将收益直接打入账户！领奖后自动开启下一轮寻宝。</p>
                  <p>3. <strong>宠物转盘与玩具</strong>：每天赠送免费抽奖与逗猫棒机会，面板自动帮你抽满并翻倍。</p>
                  <p>4. <strong>多号互助拜访</strong>：每日任务需要拜访好友宠物 5 次。面板内置了多账号内部互助池，自动调用所有账号真实的宠物 ID（petId）相互拜访，全自动拿满任务奖励！</p>
                </div>
              ),
            },
            {
              key: 'fruit',
              label: '🍎 每日果园',
              children: (
                <div style={{ lineHeight: 1.8 }}>
                  <Typography.Paragraph strong>【玩法与机制】</Typography.Paragraph>
                  <p>1. <strong>自动种植</strong>：若果园为空，系统会自动选择种植性价比最高、成熟周期最短且收益最稳定的苹果树。</p>
                  <p>2. <strong>收集水滴</strong>：每日签到、喂猫、看视频均可获得水滴营养液，面板会自动做完并领取全部水滴。</p>
                  <p>3. <strong>全自动浇水</strong>：只要有水滴，面板会自动浇水推进果树成熟进度。</p>
                  <p>4. <strong>果实成熟收获</strong>：果实达到 100% 成熟后，面板自动收取果实并兑换为说道币/叮咚币（通常为 7~10 个币，有效期 3 个月），收成记录永久在面板存档。</p>
                </div>
              ),
            },
            {
              key: 'knife',
              label: '🗡️ 飞刀国王',
              children: (
                <div style={{ lineHeight: 1.8 }}>
                  <Typography.Paragraph strong>【玩法与机制】</Typography.Paragraph>
                  <p>1. <strong>飞刀转盘</strong>：向旋转转盘投掷飞刀，命中水果获得果汁金币，击中宝箱可获取额外宝箱道具。</p>
                  <p>2. <strong>看广告加次数</strong>：每日上限 15 次，面板自动做完看广告拿满全部游戏机会。</p>
                  <p>3. <strong>开宝箱与轮盘抽奖</strong>：定时宝箱到期后自动开启；每局游戏结束后自动进入十级幸运转盘进行抽奖并翻倍！</p>
                </div>
              ),
            },
            {
              key: 'math',
              label: '🧮 算术不等式',
              children: (
                <div style={{ lineHeight: 1.8 }}>
                  <Typography.Paragraph strong>【玩法与机制】</Typography.Paragraph>
                  <p>1. <strong>不等式答题</strong>：通过云端 WebSocket 对决，系统自动毫秒级秒算不等式真假，并模拟真人延时回传答案。</p>
                  <p>2. <strong>冲榜前十策略</strong>：若排名跌出前 10，系统自动对标当前第 1~9 名的分数（超越第 2~5 名最高分），保证答题数量直接冲进全球前 10！</p>
                  <p>3. <strong>积分兑换说道币</strong>：积分支持 1,000分 与 10,000分 两档兑换说道币/叮咚币，面板提供手动兑换按钮，日常中积分达标亦会自动兑换！</p>
                  <p>4. <strong>换 IP 助力</strong>：每个短链码（shortUuid）每日上限 20 次助力。在系统设置中配置动态代理池后，系统会自动提取不同公网 IP 刷满助力次数！</p>
                </div>
              ),
            },
          ]}
        />
      </Modal>

      {/* 世界前 50 排行榜 Modal */}
      <Modal
        title="🏆 算术挑战 - 世界前 50 排行榜"
        open={rankModalOpen}
        onCancel={() => setRankModalOpen(false)}
        footer={null}
        width={720}
      >
        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Radio.Group
            value={selectedRankAppId}
            onChange={(e) => void handleOpenRank(e.target.value)}
            buttonStyle="solid"
            size="small"
          >
            <Radio.Button value={66}>叮咚排行榜 (AppId 66)</Radio.Button>
            <Radio.Button value={67}>说道排行榜 (AppId 67)</Radio.Button>
          </Radio.Group>
          <Tag color="cyan">
            当前账号归属: {data?.gameAppId === 67 ? '说道榜单 (67)' : '叮咚榜单 (66)'} (独立隔离不互串)
          </Tag>
        </div>
        <div style={{ marginBottom: 12 }}>
          <Alert
            type="info"
            showIcon
            message={selectedRankAppId === (data?.gameAppId || 66) ? '当前展示账号所属主榜单' : '当前展示另一端排行榜（只读查看）'}
            description={`冲榜与挑战成绩严格隔离在账号自身主端（${data?.gameAppId === 67 ? '说道' : '叮咚'}），互助双码仅用于换IP助力获取做题机会，绝不会发生跨端串榜！`}
          />
        </div>
        <Table<RankLeaderboardItem>
          dataSource={rankList}
          rowKey="uid"
          loading={rankLoading}
          size="small"
          pagination={{ pageSize: 10, showTotal: (total) => `共 ${total} 位排位玩家` }}
          columns={[
            {
              title: '名次',
              dataIndex: 'ranking',
              width: 75,
              render: (rank: number) => {
                if (rank === 1) return <Tag color="gold" style={{ fontSize: 13, fontWeight: 'bold' }}>🥇 1</Tag>;
                if (rank === 2) return <Tag color="default" style={{ fontSize: 13, fontWeight: 'bold' }}>🥈 2</Tag>;
                if (rank === 3) return <Tag color="orange" style={{ fontSize: 13, fontWeight: 'bold' }}>🥉 3</Tag>;
                if (rank <= 10) return <Tag color="blue">{rank}</Tag>;
                return <span>{rank}</span>;
              },
            },
            {
              title: '玩家昵称',
              dataIndex: 'nickname',
              ellipsis: true,
              render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
            },
            {
              title: '国家 / 地区',
              dataIndex: 'countryName',
              width: 150,
              ellipsis: true,
            },
            {
              title: '最高得分',
              dataIndex: 'bestScore',
              width: 100,
              sorter: (a, b) => b.bestScore - a.bestScore,
              render: (score: number) => (
                <Typography.Text strong style={{ color: '#d46b08', fontSize: 14 }}>
                  {score} 分
                </Typography.Text>
              ),
            },
          ]}
        />
      </Modal>

      {/* 算术冲榜 Modal */}
      <Modal
        title="🏆 算术挑战 - 立即冲榜"
        open={climbModalOpen}
        onCancel={() => setClimbModalOpen(false)}
        onOk={() => void handleClimbRank()}
        okText="立即冲榜"
        confirmLoading={actionLoading === 'climb'}
        width={500}
      >
        <Space direction="vertical" size={14} style={{ width: '100%', marginTop: 8 }}>
          <Alert
            type="info"
            showIcon
            message="智能冲榜机制说明"
            description="系统将模拟真实答题并向服务端提交成绩。默认随机超越第 2~6 名，稳妥进入全球前十名！"
          />
          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>选择目标名次：</div>
            <Select
              style={{ width: '100%' }}
              value={targetRankChoice}
              onChange={(val) => setTargetRankChoice(val)}
              options={[
                { value: 0, label: '🎲 智能随机超越第 2 ~ 6 名 (推荐)' },
                { value: 2, label: '🥈 冲向第 2 名 (超越 #2 分数)' },
                { value: 3, label: '🥉 冲向第 3 名 (超越 #3 分数)' },
                { value: 4, label: '冲向第 4 名 (超越 #4 分数)' },
                { value: 5, label: '冲向第 5 名 (超越 #5 分数)' },
                { value: 6, label: '冲向第 6 名 (超越 #6 分数)' },
                { value: -1, label: '✍️ 自定义目标答题得分' },
              ]}
            />
          </div>
          {targetRankChoice === -1 && (
            <div>
              <div style={{ marginBottom: 6, fontWeight: 500 }}>自定义目标得分：</div>
              <InputNumber
                style={{ width: '100%' }}
                min={10}
                max={999}
                value={customScoreInput}
                onChange={(val) => setCustomScoreInput(val || 430)}
                addonAfter="分"
              />
            </div>
          )}
        </Space>
      </Modal>
      {/* 会员奖励历史 Modal */}
      <Modal
        title="🎁 会员好运抽奖与每日签到中奖历史"
        open={memberHistoryModalOpen}
        onCancel={() => setMemberHistoryModalOpen(false)}
        footer={null}
        width={680}
      >
        <Table
          size="small"
          rowKey={(r: any, index) => `${r.receivedAt}-${index}`}
          dataSource={data?.member?.history ?? []}
          pagination={{ pageSize: 8, hideOnSinglePage: true }}
          locale={{ emptyText: '暂无中奖记录' }}
          columns={[
            {
              title: '时间',
              dataIndex: 'receivedAt',
              key: 'receivedAt',
              width: 170,
              render: (val: string) => (val ? new Date(val).toLocaleString() : '-'),
            },
            {
              title: '来源活动',
              dataIndex: 'sourceName',
              key: 'sourceName',
              width: 140,
              render: (val: string) => <Tag color={val.includes('转盘') ? 'orange' : 'cyan'}>{val}</Tag>,
            },
            {
              title: '获得奖品',
              dataIndex: 'prizeName',
              key: 'prizeName',
              render: (val: string) => (
                <Typography.Text strong style={{ color: '#d46b08' }}>
                  {val}
                </Typography.Text>
              ),
            },
          ]}
        />
      </Modal>

    </Space>
  );
}
