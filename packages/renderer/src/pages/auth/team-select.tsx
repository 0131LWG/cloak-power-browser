import {Button, List, Space, Tag, message} from 'antd';
import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {fetchTeams, getSavedSettings, saveCloudSession, type CloudTeam} from '/@/utils/cloud-auth';
import type {SettingOptions} from '../../../../shared/types/common';
import './index.css';

export default function TeamSelect() {
  const [settings, setSettings] = useState<SettingOptions>();
  const [teams, setTeams] = useState<CloudTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [messageApi, contextHolder] = message.useMessage();
  const navigate = useNavigate();

  const loadTeams = async () => {
    setLoading(true);
    try {
      const savedSettings = await getSavedSettings();
      setSettings(savedSettings);
      const apiBaseUrl = savedSettings.cloudSync?.apiBaseUrl || '';
      const accessToken = savedSettings.cloudSync?.accessToken || '';
      if (!apiBaseUrl || !accessToken) {
        navigate('/auth/login', {replace: true});
        return;
      }
      setTeams(await fetchTeams(apiBaseUrl, accessToken));
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
                  description={team.id}
                />
              </List.Item>
            )}
          />
          <Button style={{marginTop: 16}} onClick={() => navigate('/auth/login')}>
            返回登录
          </Button>
        </div>
      </div>
    </div>
  );
}
