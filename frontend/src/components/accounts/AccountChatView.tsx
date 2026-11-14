import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Input, Button, List, Avatar, Badge, Tag, Space, Typography, Tooltip, Modal, Form, Popconfirm, Empty, Spin, message, Select
} from 'antd';
import {
  SendOutlined, SearchOutlined, PlusOutlined, PushpinOutlined, PushpinFilled,
  BellOutlined, BellFilled, StopOutlined, UserAddOutlined, CopyOutlined, ReloadOutlined, CheckCircleOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type {
  ConversationItem, ConversationRateInfo
} from '../../services/endpoints';
import {
  getAccountConversations, getConversationMessages, getConversationRate, sendAccountSms, updateConversationSetting, saveAccountContact
} from '../../services/endpoints';
import { markMessageAsSent } from '../../services/sent-cache';
import type { Message, PhoneNumber } from '../../types';

interface AccountChatViewProps {
  accountId: number;
  initialPeer?: string;
  onOpenContacts?: () => void;
  accountPhones?: PhoneNumber[];
}

function getAvatarColor(str: string): string {
  const colors = ['#f56a00', '#7265e6', '#ffbf00', '#00a2ae', '#1890ff', '#52c41a', '#eb2f96'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function extractCode(content: string): string | null {
  const match = content.match(/\b(\d{4,8})\b/);
  return match ? match[1] : null;
}

export const AccountChatView: React.FC<AccountChatViewProps> = ({ accountId, initialPeer, onOpenContacts, accountPhones }) => {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState<string | null>(initialPeer || null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [inputContent, setInputContent] = useState('');
  const [sending, setSending] = useState(false);
  const [rateInfo, setRateInfo] = useState<ConversationRateInfo | null>(null);
  const [selectedSenderPhone, setSelectedSenderPhone] = useState<string>('');

  useEffect(() => {
    if (accountPhones && accountPhones.length > 0 && !selectedSenderPhone) {
      const primary = accountPhones.find((p) => p.is_primary) || accountPhones[0];
      if (primary) setSelectedSenderPhone(primary.phone_number);
    }
  }, [accountPhones, selectedSenderPhone]);
  const [newChatModalOpen, setNewChatModalOpen] = useState(false);
  const [newChatPhone, setNewChatPhone] = useState('');
  const [newChatMsg, setNewChatMsg] = useState('');
  const [newChatSenderPhone, setNewChatSenderPhone] = useState<string>('');
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [contactForm] = Form.useForm();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (accountPhones && accountPhones.length > 0 && !newChatSenderPhone) {
      const primary = accountPhones.find((p) => p.is_primary) || accountPhones[0];
      if (primary) setNewChatSenderPhone(primary.phone_number);
    }
  }, [accountPhones, newChatSenderPhone]);

  const fetchConversations = async (silent = false) => {
    if (!silent) setLoadingConv(true);
    try {
      const list = await getAccountConversations(accountId);
      setConversations(list || []);
      if (!selectedPeer && list && list.length > 0) setSelectedPeer(list[0].peerNumber);
    } catch {
      if (!silent) message.error('获取短信会话列表失败');
    } finally {
      if (!silent) setLoadingConv(false);
    }
  };

  const fetchMessages = async (peer: string) => {
    setLoadingMsgs(true);
    try {
      const [msgs, rate] = await Promise.all([
        getConversationMessages(accountId, peer),
        getConversationRate(accountId, peer).catch(() => null)
      ]);
      setMessages(msgs || []);
      setRateInfo(rate);
      setConversations((prev) => prev.map((c) => (c.peerNumber === peer ? { ...c, unreadCount: 0 } : c)));
    } catch {
      message.error('获取聊天记录失败');
    } finally {
      setLoadingMsgs(false);
    }
  };

  useEffect(() => { fetchConversations(); }, [accountId]);
  useEffect(() => { if (initialPeer) setSelectedPeer(initialPeer); }, [initialPeer]);
  useEffect(() => {
    if (selectedPeer) fetchMessages(selectedPeer);
    else { setMessages([]); setRateInfo(null); }
  }, [accountId, selectedPeer]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const handleSend = async () => {
    if (!selectedPeer || !inputContent.trim()) return;
    const content = inputContent.trim();
    markMessageAsSent(content, accountId);
    setSending(true);
    try {
      const res = await sendAccountSms(accountId, { to: selectedPeer, content, from: selectedSenderPhone || undefined });
      setInputContent('');
      message.success(res.info || '短信已记录');
      setMessages((prev) => [...prev, res.message]);
      fetchConversations(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const handleToggleSetting = async (peer: string, key: 'is_pinned' | 'is_muted' | 'is_blocked', currentVal: boolean) => {
    try {
      await updateConversationSetting(accountId, peer, { [key]: !currentVal });
      setConversations((prev) =>
        prev.map((c) => (c.peerNumber === peer ? { ...c, [key === 'is_pinned' ? 'isPinned' : key === 'is_muted' ? 'isMuted' : 'isBlocked']: !currentVal } : c))
      );
      message.success('设置已更新');
      fetchConversations(true);
    } catch {
      message.error('更新设置失败');
    }
  };

  const handleSaveContact = async () => {
    try {
      const values = await contactForm.validateFields();
      await saveAccountContact(accountId, values);
      message.success('联系人保存成功');
      setContactModalOpen(false);
      fetchConversations(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    }
  };

  const handleStartNewChat = async () => {
    if (!newChatPhone.trim()) { message.warning('请输入目标手机号码'); return; }
    const target = newChatPhone.trim();
    const sender = newChatSenderPhone || selectedSenderPhone;
    if (sender) setSelectedSenderPhone(sender);
    setNewChatModalOpen(false);
    setSelectedPeer(target);
    if (newChatMsg.trim()) {
      markMessageAsSent(newChatMsg.trim(), accountId);
      try {
        const res = await sendAccountSms(accountId, { to: target, content: newChatMsg.trim(), from: sender || undefined });
        message.success(res.info || '短信发送成功');
        fetchMessages(target);
        fetchConversations(true);
      } catch (err) {
        message.error(err instanceof Error ? err.message : '发送失败');
      }
    }
    setNewChatPhone('');
    setNewChatMsg('');
  };

  const copyToClipboard = (text: string, tip = '已复制') => {
    navigator.clipboard.writeText(text);
    message.success(tip);
  };

  const filteredConversations = useMemo(() => {
    if (!searchText.trim()) return conversations;
    const q = searchText.toLowerCase().trim();
    return conversations.filter(
      (c) =>
        c.peerNumber.toLowerCase().includes(q) ||
        (c.contactName && c.contactName.toLowerCase().includes(q)) ||
        (c.lastMessage && c.lastMessage.content.toLowerCase().includes(q))
    );
  }, [conversations, searchText]);

  const activeConversation = useMemo(() => conversations.find((c) => c.peerNumber === selectedPeer), [conversations, selectedPeer]);

  return (
    <div style={{ display: 'flex', height: '620px', border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
      {/* 左侧会话列表 */}
      <div style={{ width: 320, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
          <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
            <Typography.Text strong style={{ fontSize: 16 }}>💬 短信会话</Typography.Text>
            <Space>
              {onOpenContacts && (
                <Button size="small" onClick={onOpenContacts}>通讯录</Button>
              )}
              <Tooltip title="刷新会话"><Button size="small" icon={<ReloadOutlined />} onClick={() => fetchConversations()} /></Tooltip>
              <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setNewChatModalOpen(true)}>发短信</Button>
            </Space>
          </Space>
          <Input placeholder="搜索号码 / 联系人 / 消息" prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />} allowClear value={searchText} onChange={(e) => setSearchText(e.target.value)} size="small" />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loadingConv ? (
            <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
          ) : filteredConversations.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无短信会话" style={{ marginTop: 60 }} />
          ) : (
            <List
              dataSource={filteredConversations}
              renderItem={(item) => {
                const isSelected = item.peerNumber === selectedPeer;
                const code = extractCode(item.lastMessage?.content || '');
                return (
                  <div
                    key={item.peerNumber}
                    onClick={() => setSelectedPeer(item.peerNumber)}
                    style={{
                      padding: '10px 14px',
                      cursor: 'pointer',
                      borderBottom: '1px solid #f5f5f5',
                      background: isSelected ? '#e6f4ff' : item.isPinned ? '#fffbe6' : '#fff',
                      transition: 'all 0.2s'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <Badge count={item.unreadCount} overflowCount={99}>
                        <Avatar style={{ backgroundColor: getAvatarColor(item.peerNumber), verticalAlign: 'middle' }}>
                          {item.countryFlag || (item.contactName ? item.contactName.slice(0, 1) : item.peerNumber.slice(-2))}
                        </Avatar>
                      </Badge>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                          <Typography.Text strong ellipsis style={{ fontSize: 13, color: isSelected ? '#1677ff' : '#262626' }}>
                            {item.contactName || item.peerNumber}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0, marginLeft: 6 }}>
                            {dayjs(item.lastMessage?.receivedAt).format('MM-DD HH:mm')}
                          </Typography.Text>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 170 }}>
                            {code ? ('[验证码: ' + code + '] ') : ''}{item.lastMessage?.content || '(无文字内容)'}
                          </Typography.Text>
                          <Space size={4} style={{ flexShrink: 0 }}>
                            {item.isPinned && <PushpinFilled style={{ color: '#faad14', fontSize: 12 }} />}
                            {item.isMuted && <BellFilled style={{ color: '#8c8c8c', fontSize: 12 }} />}
                            {item.isBlocked && <StopOutlined style={{ color: '#ff4d4f', fontSize: 12 }} />}
                          </Space>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }}
            />
          )}
        </div>
      </div>

      {/* 右侧聊天窗口 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#f5f7fa' }}>
        {selectedPeer ? (
          <>
            <div style={{ padding: '10px 20px', background: '#fff', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Space align="center" size={8}>
                  <Typography.Text strong style={{ fontSize: 15 }}>
                    {activeConversation?.contactName ? (activeConversation.contactName + ' (' + selectedPeer + ')') : selectedPeer}
                  </Typography.Text>
                  {activeConversation?.countryFlag && (
                    <Tag color="cyan">{activeConversation.countryFlag} {activeConversation.countryName}</Tag>
                  )}
                  {rateInfo && (
                    <Tag color="blue">💬 短信费率: {rateInfo.rate_sms} {rateInfo.currency}/条</Tag>
                  )}
                  {activeConversation?.isBlocked && <Tag color="error">已拦截</Tag>}
                  {activeConversation?.isMuted && <Tag color="warning">免打扰</Tag>}
                </Space>
                {accountPhones && accountPhones.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <Space size={6}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>我方发信号码:</Typography.Text>
                      <Select
                        size="small"
                        value={selectedSenderPhone}
                        onChange={setSelectedSenderPhone}
                        style={{ minWidth: 220 }}
                        placeholder="选择我方发信号码"
                      >
                        {accountPhones.map((p) => (
                          <Select.Option key={p.phone_number} value={p.phone_number}>
                            {p.phone_number} {p.display_name ? ('(' + p.display_name + ')') : ''} {p.is_primary ? '🌟 默认' : ''}
                          </Select.Option>
                        ))}
                      </Select>
                    </Space>
                  </div>
                )}
              </div>
              <Space size={8}>
                <Tooltip title={activeConversation?.isPinned ? '取消置顶' : '置顶会话'}>
                  <Button size="small" icon={activeConversation?.isPinned ? <PushpinFilled style={{ color: '#faad14' }} /> : <PushpinOutlined />} onClick={() => handleToggleSetting(selectedPeer, 'is_pinned', Boolean(activeConversation?.isPinned))} />
                </Tooltip>
                <Tooltip title={activeConversation?.isMuted ? '取消免打扰' : '消息免打扰'}>
                  <Button size="small" icon={activeConversation?.isMuted ? <BellFilled style={{ color: '#faad14' }} /> : <BellOutlined />} onClick={() => handleToggleSetting(selectedPeer, 'is_muted', Boolean(activeConversation?.isMuted))} />
                </Tooltip>
                <Tooltip title={activeConversation?.isBlocked ? '解除拦截' : '加入黑名单/拦截'}>
                  <Popconfirm
                    title={activeConversation?.isBlocked ? '确认解除对该号码的拦截？' : '确认拦截该号码？拦截后将拒收并停止推送该号码的消息。'}
                    onConfirm={() => handleToggleSetting(selectedPeer, 'is_blocked', Boolean(activeConversation?.isBlocked))}
                  >
                    <Button size="small" danger={!activeConversation?.isBlocked} icon={<StopOutlined />} />
                  </Popconfirm>
                </Tooltip>
                {!activeConversation?.contactName && (
                  <Button size="small" icon={<UserAddOutlined />} onClick={() => { contactForm.setFieldsValue({ phone_number: selectedPeer, name: '' }); setContactModalOpen(true); }}>存联系人</Button>
                )}
                <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchMessages(selectedPeer)} />
              </Space>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {loadingMsgs ? (
                <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="加载聊天记录..." /></div>
              ) : messages.length === 0 ? (
                <Empty description="该会话尚无短信消息" style={{ marginTop: 80 }} />
              ) : (
                messages.map((m) => {
                  const isOutgoing = m.direction === 'outgoing';
                  const code = extractCode(m.content);
                  return (
                    <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isOutgoing ? 'flex-end' : 'flex-start' }}>
                      <div style={{
                        maxWidth: '75%', padding: '10px 14px', borderRadius: 12,
                        background: isOutgoing ? '#1677ff' : '#fff',
                        color: isOutgoing ? '#fff' : '#262626',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                        wordBreak: 'break-word', whiteSpace: 'pre-wrap'
                      }}>
                        <div style={{ fontSize: 13, lineHeight: 1.5 }}>{m.content}</div>
                        {code && !isOutgoing && (
                          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed #e8e8e8', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Tag color="red" style={{ fontSize: 13, fontWeight: 'bold' }}>验证码: {code}</Tag>
                            <Button size="small" type="link" icon={<CopyOutlined />} onClick={() => copyToClipboard(code, '验证码 ' + code + ' 已复制')}>复制验证码</Button>
                          </div>
                        )}
                      </div>
                      <div style={{ marginTop: 3, fontSize: 11, color: '#8c8c8c' }}>
                        {isOutgoing && m.from_number ? ('由 ' + m.from_number + ' 发送 · ') : ''}
                        {dayjs(m.received_at).format('YYYY-MM-DD HH:mm:ss')} {isOutgoing && <CheckCircleOutlined style={{ color: '#52c41a', marginLeft: 4 }} />}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <div style={{ padding: '12px 20px', background: '#fff', borderTop: '1px solid #f0f0f0' }}>
              <Input.TextArea
                value={inputContent}
                onChange={(e) => setInputContent(e.target.value)}
                placeholder="输入短信内容... (Enter 发送，Shift+Enter 换行)"
                autoSize={{ minRows: 2, maxRows: 5 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                disabled={Boolean(activeConversation?.isBlocked)}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {inputContent.length > 0 ? ('共 ' + inputContent.length + ' 字 (约 ' + Math.ceil(inputContent.length / 70) + ' 条短信)') : ('使用 ' + (selectedSenderPhone || '默认号码') + ' 发往 ' + selectedPeer)}
                  {rateInfo ? (' · 预计资费: ' + rateInfo.rate_sms + ' ' + rateInfo.currency + '/条') : ''}
                </Typography.Text>
                <Button type="primary" icon={<SendOutlined />} onClick={handleSend} loading={sending} disabled={!inputContent.trim() || Boolean(activeConversation?.isBlocked)}>
                  发送短信
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
            <Empty description="请从左侧列表选择一个短信会话，或点击新建短信发起沟通" />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewChatModalOpen(true)} style={{ marginTop: 16 }}>新建短信会话</Button>
          </div>
        )}
      </div>

      <Modal title="新建短信会话" open={newChatModalOpen} onCancel={() => setNewChatModalOpen(false)} onOk={handleStartNewChat} okText="发起会话" destroyOnClose>
        <Form layout="vertical">
          <Form.Item label="我方发信号码 (对外显号)" required tooltip="选择发送该短信时向对方展示的您的专属号码">
            <Select
              value={newChatSenderPhone || selectedSenderPhone}
              onChange={(val) => { setNewChatSenderPhone(val); setSelectedSenderPhone(val); }}
              placeholder="请选择发信号码"
              style={{ width: '100%' }}
            >
              {(accountPhones || []).map((p) => (
                <Select.Option key={p.phone_number} value={p.phone_number}>
                  {p.phone_number} {p.display_name ? ('(' + p.display_name + ')') : ''} {p.is_primary ? '🌟 默认' : ''}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="接收方手机号" required tooltip="请输入包含国家码的完整号码，如 +14163424870">
            <Input placeholder="如 +14163424870 或 61488896087" value={newChatPhone} onChange={(e) => setNewChatPhone(e.target.value)} />
          </Form.Item>
          <Form.Item label="初始短信内容 (可选)">
            <Input.TextArea placeholder="选填，可直接发送第一条短信" rows={3} value={newChatMsg} onChange={(e) => setNewChatMsg(e.target.value)} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="存为联系人" open={contactModalOpen} onCancel={() => setContactModalOpen(false)} onOk={handleSaveContact} okText="保存" destroyOnClose>
        <Form form={contactForm} layout="vertical">
          <Form.Item name="name" label="联系人姓名" rules={[{ required: true, message: '请输入联系人姓名' }]}>
            <Input placeholder="如 Alice" />
          </Form.Item>
          <Form.Item name="phone_number" label="电话号码" rules={[{ required: true, message: '请输入电话号码' }]}>
            <Input disabled />
          </Form.Item>
          <Form.Item name="email" label="电子邮箱"><Input placeholder="选填" /></Form.Item>
          <Form.Item name="note" label="备注"><Input.TextArea placeholder="选填备注信息" rows={2} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
export default AccountChatView;
