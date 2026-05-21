import {Button, Divider, Form, Input, List, Space, Tag, Typography, message} from 'antd';
import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {
  fetchCloudJson,
  fetchTeams,
  getSavedSettings,
  saveCloudSession,
  type CloudTeam,
  type JoinRequest,
} from '/@/utils/cloud-auth';
import type {SettingOptions} from '../../../../shared/types/common';
import './index.css';

const {Text} = Typography;

export default function TeamSelect() {
  const [settings, setSettings] = useState<SettingOptions>();
  const [teams, setTeams] = useState<CloudTeam[]>([]);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [adminRequests, setAdminRequests] = useState<Record<string, JoinRequest[]>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const navigate = useNavigate();

  const getAuthContext = async () => {
    const savedSettings = settings || (await getSavedSettings());
    const apiBaseUrl = savedSettings.cloudSync?.apiBaseUrl || '';
    const accessToken = savedSettings.cloudSync?.accessToken || '';
    if (!apiBaseUrl || !accessToken) {
      navigate('/auth/login', {replace: true});
      return undefined;
    }
    return {savedSettings, apiBaseUrl, accessToken};
  };

  const loadTeams = async () => {
    setLoading(true);
    try {
      const context = await getAuthContext();
      if (!context) return;
      setSettings(context.savedSettings);
      const nextTeams = await fetchTeams(context.apiBaseUrl, context.accessToken);
      setTeams(nextTeams);
      await loadJoinRequests(context.apiBaseUrl, context.accessToken, nextTeams);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTeams();
  }, []);

  const selectTeam = async (team: CloudTeam) => {
    if (!settings?.cloudSync) return;
    await saveCloudSession(settings, {
      ...settings.cloudSync,
      workspaceId: team.id,
    });
    navigate('/', {replace: true});
  };

  const loadJoinRequests = async (apiBaseUrl: string, accessToken: string, currentTeams: CloudTeam[]) => {
    const ownRequests = await fetchCloudJson<{success: boolean; data: JoinRequest[]}>(
      apiBaseUrl,
      '/join-requests',
      {headers: {Authorization: `Bearer ${accessToken}`}},
    );
    setJoinRequests(ownRequests.data || []);

    const adminTeams = currentTeams.filter(team => team.role === 'owner' || team.role === 'admin');
    const entries = await Promise.all(
      adminTeams.map(async team => {
        const result = await fetchCloudJson<{success: boolean; data: JoinRequest[]}>(
          apiBaseUrl,
          `/teams/${team.id}/join-requests`,
          {headers: {Authorization: `Bearer ${accessToken}`}},
        );
        return [team.id, result.data || []] as const;
      }),
    );
    setAdminRequests(Object.fromEntries(entries));
  };

  const createTeam = async (values: {name: string}) => {
    const context = await getAuthContext();
    if (!context) return;
    setSubmitting(true);
    try {
      const result = await fetchCloudJson<{success: boolean; data: CloudTeam}>(
        context.apiBaseUrl,
        '/teams',
        {
          method: 'POST',
          headers: {Authorization: `Bearer ${context.accessToken}`},
          body: JSON.stringify({name: values.name}),
        },
      );
      messageApi.success('团队已创建');
      await selectTeam({...result.data, role: 'owner'});
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const requestJoin = async (values: {inviteCode: string; message?: string}) => {
    const context = await getAuthContext();
    if (!context) return;
    setSubmitting(true);
    try {
      await fetchCloudJson(context.apiBaseUrl, '/teams/join-requests', {
        method: 'POST',
        headers: {Authorization: `Bearer ${context.accessToken}`},
        body: JSON.stringify({invite_code: values.inviteCode, message: values.message}),
      });
      messageApi.success('申请已提交，等待管理员审批');
      await loadTeams();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const reviewRequest = async (teamId: string, requestId: string, action: 'approve' | 'reject') => {
    const context = await getAuthContext();
    if (!context) return;
    setSubmitting(true);
    try {
      await fetchCloudJson(context.apiBaseUrl, `/teams/${teamId}/join-requests/${requestId}/${action}`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${context.accessToken}`},
      });
      messageApi.success(action === 'approve' ? '已批准加入' : '已拒绝申请');
      await loadTeams();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const copyInviteCode = async (inviteCode: string) => {
    await navigator.clipboard.writeText(inviteCode);
    messageApi.success('邀请码已复制');
  };

  const regenerateInviteCode = async (teamId: string) => {
    const context = await getAuthContext();
    if (!context) return;
    setSubmitting(true);
    try {
      await fetchCloudJson(context.apiBaseUrl, `/teams/${teamId}/invite-code/regenerate`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${context.accessToken}`},
      });
      messageApi.success('邀请码已生成');
      await loadTeams();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      {contextHolder}
      <div className="auth-brand">
        <div>
          <h1 className="auth-brand-title">选择团队</h1>
          <p className="auth-brand-copy">
            选择后，窗口、代理、扩展和 profile 同步都会限定在该团队内。
          </p>
        </div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <h1>团队</h1>
          <p className="auth-subtitle">选择本次工作的团队空间。</p>
          <List
            loading={loading}
            dataSource={teams}
            locale={{emptyText: '当前账号还没有团队'}}
            renderItem={team => (
              <List.Item
                actions={[
                  <Button key="select" type="primary" onClick={() => selectTeam(team)}>
                    进入
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      {team.name}
                      {team.role && <Tag>{team.role}</Tag>}
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={2}>
                      <Text type="secondary">{team.id}</Text>
                      {(team.role === 'owner' || team.role === 'admin') && team.invite_code && (
                        <Space>
                          <Text code>{team.invite_code}</Text>
                          <Button size="small" onClick={() => copyInviteCode(team.invite_code!)}>
                            复制邀请码
                          </Button>
                        </Space>
                      )}
                      {(team.role === 'owner' || team.role === 'admin') && !team.invite_code && (
                        <Button size="small" loading={submitting} onClick={() => regenerateInviteCode(team.id)}>
                          生成邀请码
                        </Button>
                      )}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
          <Divider />
          <Text strong>创建团队</Text>
          <Form layout="vertical" onFinish={createTeam} style={{marginTop: 12}}>
            <Form.Item name="name" label="团队名称" rules={[{required: true}]}>
              <Input />
            </Form.Item>
            <Button htmlType="submit" loading={submitting}>
              创建团队
            </Button>
          </Form>
          <Divider />
          <Text strong>用邀请码申请加入</Text>
          <Form layout="vertical" onFinish={requestJoin} style={{marginTop: 12}}>
            <Form.Item name="inviteCode" label="邀请码" rules={[{required: true}]}>
              <Input />
            </Form.Item>
            <Form.Item name="message" label="申请说明">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Button htmlType="submit" loading={submitting}>
              提交申请
            </Button>
          </Form>
          {joinRequests.length > 0 && (
            <>
              <Divider />
              <Text strong>我的加入申请</Text>
              <List
                dataSource={joinRequests}
                renderItem={request => (
                  <List.Item>
                    <List.Item.Meta
                      title={
                        <Space>
                          {request.team?.name || request.team_id}
                          <Tag>{request.status}</Tag>
                        </Space>
                      }
                      description={request.message || request.created_at}
                    />
                  </List.Item>
                )}
              />
            </>
          )}
          {Object.entries(adminRequests).some(([, requests]) => requests.length > 0) && (
            <>
              <Divider />
              <Text strong>待审批申请</Text>
              {Object.entries(adminRequests).map(([teamId, requests]) =>
                requests.length ? (
                  <List
                    key={teamId}
                    dataSource={requests}
                    renderItem={request => (
                      <List.Item
                        actions={[
                          <Button
                            key="approve"
                            type="primary"
                            loading={submitting}
                            onClick={() => reviewRequest(teamId, request.id, 'approve')}
                          >
                            批准
                          </Button>,
                          <Button
                            key="reject"
                            loading={submitting}
                            onClick={() => reviewRequest(teamId, request.id, 'reject')}
                          >
                            拒绝
                          </Button>,
                        ]}
                      >
                        <List.Item.Meta
                          title={request.user?.name || request.user?.email || request.user_id}
                          description={request.message || request.created_at}
                        />
                      </List.Item>
                    )}
                  />
                ) : null,
              )}
            </>
          )}
          <Button style={{marginTop: 16}} onClick={() => navigate('/auth/login')}>
            返回登录
          </Button>
        </div>
      </div>
    </div>
  );
}
