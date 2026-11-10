import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Modal,
  Progress,
  Space,
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
  GlobalOutlined,
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
  redeemMathGamePoints,
  runAccountGameDaily,
  runAccountKnifeDaily,
  runAllAccountsGameDaily,
  waterAccountFruit,
  addXiequWhitelist,
  runAccountMemberDaily,
  runAccountMathDaily,
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

  // Modals state
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

  const handleAddWhitelist = async () => {
    setActionLoading('whitelist');
    try {
      const res = await addXiequWhitelist();
      if (res.success) {
        message.success(`当前服务器公网 IP (${res.ip}) 已成功添加至携趣白名单！`);
      } else {
        message.info(`白名单响应: ${res.message} (IP: ${res.ip})`);
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '添加携趣白名单失败');
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

  const handleOpenRank = async () => {
    setRankModalOpen(true);
    setRankLoading(true);
    try {
      const list = await getGameRankList(data?.gameAppId || 66);
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

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 顶部状态与全局控制条 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <Space wrap align="center">
          <Typography.Title level={4} style={{ margin: 0 }}>🎮 游戏与福利自动化中心</Typography.Title>
          <Tag color="cyan">客户端: {data?.appType === 0 ? '叮咚 (0)' : '说道 (3)'}</Tag>
        </Space>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadData()}>刷新数据</Button>
          <Button icon={<StarOutlined />} loading={actionLoading === 'member'} onClick={() => void handleRunMemberDaily()}>会员好运/签到</Button>
          <Button icon={<GlobalOutlined />} loading={actionLoading === 'whitelist'} onClick={() => void handleAddWhitelist()}>加携趣白名单</Button>
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

      {/* 说道币/积分到期提醒横幅 */}
      {expiry && (expiry.expireCredit > 0 || expiry.expireDate) ? (
        <Alert
          type="warning"
          showIcon
          icon={<ClockCircleOutlined />}
          message="🌟 会员商城积分年底到期提醒"
          description={(
            <Space direction="vertical" size={2}>
              <Typography.Text>
                当前账户有 <Typography.Text strong type="warning">{expiry.expireCredit}</Typography.Text> 会员积分
                {expiry.expireDate ? <>，将于 <Typography.Text strong>{expiry.expireDate}</Typography.Text> 年底到期。</> : ' 即将到期。'}
                注：说道币 / 叮咚币为永久有效钱包余额（保持账号活跃即可），此处到期仅指商城会员积分。
              </Typography.Text>
            </Space>
          )}
        />
      ) : null}

      {/* 4 大游戏功能卡片网格 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 16 }}>
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
            <Descriptions size="small" column={1} bordered>
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
                loading={actionLoading === 'water'}
                onClick={() => void handleWaterFruit()}
              >
                浇水
              </Button>
            </Space>
          )}
        >
          {fruit ? (
            <Descriptions size="small" column={1} bordered>
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
            <Descriptions size="small" column={1} bordered>
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
            <Space size={6}>
              <Tooltip title="查看玩法说明"><Button size="small" type="text" icon={<InfoCircleOutlined />} onClick={() => openGuide('math')} /></Tooltip>
              <Button size="small" icon={<TrophyOutlined />} onClick={handleOpenRank}>排行榜</Button>
              <Button size="small" icon={<ThunderboltOutlined />} loading={actionLoading === 'math'} onClick={() => void handleRunMathDaily()}>冲榜/做题</Button>
            </Space>
          )}
        >
          {math ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="当前积分余额">
                <Space>
                  <Typography.Text strong style={{ fontSize: 16, color: '#d46b08' }}>
                    {math.validPoint ?? 0}
                  </Typography.Text>
                  {math.expirePoint ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
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
              <Descriptions.Item label="推广短链码 (shortUuid)">
                <Space size={6} wrap>
                  <Tag color="purple" style={{ fontSize: 13 }}>{math.shortUuid || '未生成'}</Tag>
                  {math.shortUuid ? (
                    <Tooltip title="复制完整推广链接">
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
                  ) : null}
                  <Tag color={math.shareBoostToday?.isMaxReached ? 'default' : 'green'}>
                    今日已助力: +{math.shareBoostToday?.count ?? 0} 次 {math.shareBoostToday?.isMaxReached ? '(已达上限)' : ''}
                  </Tag>
                  <Button
                    size="small"
                    icon={<ShareAltOutlined />}
                    disabled={math.shareBoostToday?.isMaxReached}
                    loading={actionLoading === 'boost'}
                    onClick={() => void handleShareBoost()}
                  >
                    换IP助力
                  </Button>
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
          ) : (
            <Empty description="暂无算术游戏数据" />
          )}
        </Card>
        {/* 卡片 5: 会员好运与每日签到 (Member & Roulette) */}
        <Card
          title={(
            <Space>
              <span>🌟 会员好运签到</span>
              {member?.lastReward ? <Tag color="gold">最近: {member.lastReward}</Tag> : null}
            </Space>
          )}
          extra={(
            <Space size={6}>
              <Button
                size="small"
                icon={<ClockCircleOutlined />}
                onClick={() => setMemberHistoryModalOpen(true)}
              >
                奖励历史
              </Button>
              <Button
                size="small"
                icon={<StarOutlined />}
                loading={actionLoading === 'member'}
                onClick={() => void handleRunMemberDaily()}
              >
                签到/抽奖
              </Button>
            </Space>
          )}
        >
          <Descriptions size="small" column={1} bordered>
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
        width={700}
      >
        <div style={{ marginBottom: 12 }}>
          <Alert
            type="info"
            showIcon
            message="智能冲榜策略已生效"
            description="当账号跌出前 10 时，系统自动选择当前榜单前列最高分进行超越，保证冲进世界前 10 强！"
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