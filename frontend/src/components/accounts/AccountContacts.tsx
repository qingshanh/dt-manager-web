import React, { useState, useEffect, useMemo } from 'react';
import {
  Card, Table, Button, Input, Space, Modal, Form, Typography, Tooltip, Popconfirm, Avatar, message
} from 'antd';
import {
  UserAddOutlined, SearchOutlined, StarOutlined, StarFilled, MessageOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, ExportOutlined
} from '@ant-design/icons';
import type { ContactItem } from '../../services/endpoints';
import {
  getAccountContacts, saveAccountContact, deleteAccountContact
} from '../../services/endpoints';
import type { ColumnsType } from 'antd/es/table';

interface AccountContactsProps {
  accountId: number;
  onSelectChat?: (phoneNumber: string) => void;
}

function getAvatarColor(str: string): string {
  const colors = ['#f56a00', '#7265e6', '#ffbf00', '#00a2ae', '#1890ff', '#52c41a', '#eb2f96'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export const AccountContacts: React.FC<AccountContactsProps> = ({ accountId, onSelectChat }) => {
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactItem | null>(null);
  const [form] = Form.useForm();

  const fetchContacts = async () => {
    setLoading(true);
    try {
      const data = await getAccountContacts(accountId);
      setContacts(data || []);
    } catch {
      message.error('获取通讯录失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContacts();
  }, [accountId]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      await saveAccountContact(accountId, {
        id: editingContact?.id,
        ...values
      });
      message.success(editingContact ? '联系人更新成功' : '联系人添加成功');
      setModalOpen(false);
      setEditingContact(null);
      form.resetFields();
      fetchContacts();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    }
  };

  const handleDelete = async (contactId: number) => {
    try {
      await deleteAccountContact(accountId, contactId);
      message.success('联系人已删除');
      setContacts((prev) => prev.filter((c) => c.id !== contactId));
    } catch {
      message.error('删除联系人失败');
    }
  };

  const handleToggleStar = async (contact: ContactItem) => {
    try {
      await saveAccountContact(accountId, {
        id: contact.id,
        name: contact.name,
        phone_number: contact.phone_number,
        starred: !contact.starred
      });
      setContacts((prev) =>
        prev.map((c) => (c.id === contact.id ? { ...c, starred: !c.starred } : c))
      );
    } catch {
      message.error('设置星标失败');
    }
  };

  const handleExportCsv = () => {
    if (contacts.length === 0) {
      message.warning('当前通讯录为空，无数据可导出');
      return;
    }
    const headers = ['姓名', '手机号码', '邮箱', '备注', '星标'];
    const rows = contacts.map((c) => [
      '"' + (c.name || '').replace(/"/g, '""') + '"',
      '"' + (c.phone_number || '').replace(/"/g, '""') + '"',
      '"' + (c.email || '').replace(/"/g, '""') + '"',
      '"' + (c.note || '').replace(/"/g, '""') + '"',
      c.starred ? '是' : '否'
    ]);
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '通讯录_' + accountId + '.csv';
    a.click();
    URL.revokeObjectURL(url);
    message.success('通讯录 CSV 导出成功');
  };

  const filteredContacts = useMemo(() => {
    if (!searchText.trim()) return contacts;
    const q = searchText.toLowerCase().trim();
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone_number.toLowerCase().includes(q) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.note && c.note.toLowerCase().includes(q))
    );
  }, [contacts, searchText]);

  const columns: ColumnsType<ContactItem> = [
    {
      title: '星标',
      dataIndex: 'starred',
      width: 60,
      align: 'center',
      render: (starred: boolean, record) => (
        <span style={{ cursor: 'pointer', fontSize: 16 }} onClick={() => handleToggleStar(record)}>
          {starred ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined style={{ color: '#bfbfbf' }} />}
        </span>
      )
    },
    {
      title: '姓名',
      dataIndex: 'name',
      width: 160,
      render: (name: string) => (
        <Space>
          <Avatar size="small" style={{ backgroundColor: getAvatarColor(name) }}>
            {name.slice(0, 1)}
          </Avatar>
          <Typography.Text strong>{name}</Typography.Text>
        </Space>
      )
    },
    {
      title: '手机号码',
      dataIndex: 'phone_number',
      width: 180,
      render: (phone: string) => (
        <Space size={4}>
          <Typography.Text copyable={{ text: phone, tooltips: ['点击复制', '已复制'] }}>
            {phone}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: '电子邮箱',
      dataIndex: 'email',
      width: 180,
      render: (email?: string | null) => email || '-'
    },
    {
      title: '备注信息',
      dataIndex: 'note',
      render: (note?: string | null) => note || '-'
    },
    {
      title: '操作',
      width: 200,
      render: (_, record) => (
        <Space size={8}>
          <Button
            size="small"
            type="primary"
            icon={<MessageOutlined />}
            onClick={() => onSelectChat?.(record.phone_number)}
          >
            发短信
          </Button>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditingContact(record);
              form.setFieldsValue(record);
              setModalOpen(true);
            }}
          >
            编辑
          </Button>
          <Popconfirm title="确认删除该联系人？" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <Card size="small" style={{ minHeight: 520 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space size={12}>
          <Input
            placeholder="搜索联系人姓名 / 号码 / 备注"
            prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
            allowClear
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 260 }}
            size="small"
          />
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            共 {filteredContacts.length} 位联系人
          </Typography.Text>
        </Space>
        <Space>
          <Tooltip title="刷新通讯录"><Button size="small" icon={<ReloadOutlined />} onClick={fetchContacts} /></Tooltip>
          <Button size="small" icon={<ExportOutlined />} onClick={handleExportCsv}>导出 CSV</Button>
          <Button
            type="primary"
            size="small"
            icon={<UserAddOutlined />}
            onClick={() => {
              setEditingContact(null);
              form.resetFields();
              setModalOpen(true);
            }}
          >
            新建联系人
          </Button>
        </Space>
      </div>

      <Table
        dataSource={filteredContacts}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="middle"
        pagination={{ pageSize: 15, showTotal: (t) => '共 ' + t + ' 位联系人' }}
      />

      <Modal
        title={editingContact ? '编辑联系人' : '新建联系人'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditingContact(null); }}
        onOk={handleSave}
        okText="保存"
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入联系人姓名' }]}>
            <Input placeholder="如 Alice / 王经理" />
          </Form.Item>
          <Form.Item name="phone_number" label="电话号码" rules={[{ required: true, message: '请输入电话号码' }]}>
            <Input placeholder="包含国家码，如 +14163424870 或 61488896087" />
          </Form.Item>
          <Form.Item name="email" label="电子邮箱">
            <Input placeholder="选填，如 user@example.com" />
          </Form.Item>
          <Form.Item name="note" label="备注说明">
            <Input.TextArea placeholder="选填备注信息，如重要客户/同事" rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
export default AccountContacts;
