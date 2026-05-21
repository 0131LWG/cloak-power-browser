import {Button, Card, Divider, Form, Input, Select, Space, Switch, message} from 'antd';
import {CommonBridge, SyncBridge} from '#preload';
import {useEffect, useState} from 'react';
import type {SettingOptions} from '../../../../shared/types/common';
import {useTranslation} from 'react-i18next';

type FieldType = {
  profileCachePath: string;
  useLocalChrome: boolean;
  localChromePath: string;
  chromiumBinPath: string;
  automationConnect: boolean;
  cloudSync?: SettingOptions['cloudSync'];
};

type TeamOption = {
  label: string;
  value: string;
};

type SettingsFormValues = SettingOptions & {
  cloudLoginEmail?: string;
  cloudLoginPassword?: string;
  cloudRegisterTeamName?: string;
};

const toPersistedSettings = (values: SettingsFormValues): SettingOptions => {
  const {
    cloudLoginEmail: _cloudLoginEmail,
    cloudLoginPassword: _cloudLoginPassword,
    cloudRegisterTeamName: _cloudRegisterTeamName,
    ...settings
  } = values;
  return settings;
};

const Settings = () => {
  const [formValue, setFormValue] = useState<SettingOptions>({
    profileCachePath: '',
    useLocalChrome: true,
    localChromePath: '',
    chromiumBinPath: '',
    automationConnect: false,
  });
  const [teamOptions, setTeamOptions] = useState<TeamOption[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm();
  const {t} = useTranslation();

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    const settings = await CommonBridge.getSettings();
    setFormValue(settings);
    form.setFieldsValue(settings);
    if (settings.cloudSync?.apiBaseUrl && settings.cloudSync?.accessToken) {
      fetchTeams(settings.cloudSync.apiBaseUrl, settings.cloudSync.accessToken).catch(() => undefined);
    }
  };

  const handleSave = async (values: SettingsFormValues) => {
    await CommonBridge.saveSettings(toPersistedSettings(values));
    await SyncBridge?.refreshCloudSyncConfig?.();
  };

  const handleChoosePath = async (
    field: 'profileCachePath' | 'localChromePath' | 'chromiumBinPath',
    type: 'openFile' | 'openDirectory',
  ) => {
    const path = await CommonBridge.choosePath(type);
    if (!formValue[field] || (path && formValue[field] !== path)) {
      handleFormValueChange({
        ...formValue,
        [field]: path,
      });
    }
  };

  const handleFormValueChange = (changed: SettingsFormValues) => {
    const newFormValue = toPersistedSettings({
      ...formValue,
      ...changed,
    });
    setFormValue(newFormValue);
    handleSave(newFormValue);
  };

  const fetchTeams = async (apiBaseUrl: string, accessToken: string) => {
    const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/teams`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch teams');
    }
    const options = (result.data || []).map((team: {id: string; name: string; role?: string}) => ({
      label: `${team.name}${team.role ? ` (${team.role})` : ''}`,
      value: team.id,
    }));
    setTeamOptions(options);
    return options;
  };

  const handleCloudAuth = async (mode: 'login' | 'register') => {
    const values = form.getFieldsValue(true);
    const apiBaseUrl = values.cloudSync?.apiBaseUrl?.replace(/\/+$/, '');
    const email = values.cloudLoginEmail;
    const password = values.cloudLoginPassword;
    const teamName = values.cloudRegisterTeamName;

    if (!apiBaseUrl || !email || !password) {
      messageApi.warning('Cloud URL, email and password are required');
      return;
    }

    setCloudLoading(true);
    try {
      const response = await fetch(`${apiBaseUrl}/auth/${mode}`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          email,
          password,
          name: email,
          team_name: teamName,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.message || 'Cloud auth failed');
      }

      const teams = await fetchTeams(apiBaseUrl, result.access_token);
      const workspaceId = result.team?.id || teams[0]?.value || values.cloudSync?.workspaceId || '';
      const nextSettings = toPersistedSettings({
        ...formValue,
        ...values,
        cloudSync: {
          ...(formValue.cloudSync || {}),
          ...(values.cloudSync || {}),
          enabled: true,
          apiBaseUrl,
          accessToken: result.access_token,
          workspaceId,
          userId: result.user?.id || '',
        },
      });
      setFormValue(nextSettings);
      form.setFieldsValue(nextSettings);
      await handleSave(nextSettings);
      messageApi.success(mode === 'login' ? 'Cloud login succeeded' : 'Cloud account created');
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setCloudLoading(false);
    }
  };

  // type FieldType = SettingOptions;

  return (
    <>
      <Card
        className="content-card p-6"
        bordered={false}
      >
        {contextHolder}
        <Form
          name="settingsForm"
          className="w-2/3"
          labelCol={{span: 5}}
          size="large"
          form={form}
          initialValues={formValue}
          onValuesChange={(_, allValues) => handleFormValueChange(allValues)}
        >
          <Form.Item<FieldType>
            label={t('settings_cache_path')}
            name="profileCachePath"
          >
            <Space.Compact style={{width: '100%'}}>
              <Input
                readOnly
                disabled
                value={formValue.profileCachePath}
              />
              <Button
                type="default"
                onClick={() => handleChoosePath('profileCachePath', 'openDirectory')}
              >
                {t('settings_choose_cache_path')}
              </Button>
            </Space.Compact>
          </Form.Item>
          {/* <Form.Item<FieldType>
            label={t('settings_use_local_chrome')}
            name="useLocalChrome"
          >
            <Switch value={formValue.useLocalChrome} />
          </Form.Item> */}
          {formValue.useLocalChrome ? (
            <Form.Item<FieldType>
              label={t('settings_chrome_path')}
              name="localChromePath"
            >
              <Space.Compact style={{width: '100%'}}>
                <Input
                  readOnly
                  disabled
                  value={formValue.localChromePath}
                />
                <Button
                  type="default"
                  onClick={() => handleChoosePath('localChromePath', 'openFile')}
                >
                  {t('settings_choose_cache_path')}
                </Button>
              </Space.Compact>
            </Form.Item>
          ) : (
            <Form.Item<FieldType>
              label={t('setting_chromium_path')}
              name="chromiumBinPath"
            >
              <Space.Compact style={{width: '100%'}}>
                <Input
                  readOnly
                  disabled
                  value={formValue.chromiumBinPath}
                />
                <Button
                  type="default"
                  onClick={() => handleChoosePath('chromiumBinPath', 'openFile')}
                >
                  {t('settings_choose_cache_path')}
                </Button>
              </Space.Compact>
            </Form.Item>
          )}
          {/* <Form.Item<FieldType>
            label={t('settings_automation_connect')}
            name="automationConnect"
            >
              <Switch value={formValue.automationConnect} />
          </Form.Item> */}
          <Divider>Cloud Sync</Divider>
          <Form.Item
            label="Enable"
            name={['cloudSync', 'enabled']}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="API URL"
            name={['cloudSync', 'apiBaseUrl']}
          >
            <Input placeholder="http://your-server:8787" />
          </Form.Item>
          <Form.Item
            label="Email"
            name="cloudLoginEmail"
          >
            <Input placeholder="name@example.com" />
          </Form.Item>
          <Form.Item
            label="Password"
            name="cloudLoginPassword"
          >
            <Input.Password placeholder="password" />
          </Form.Item>
          <Form.Item
            label="New Team"
            name="cloudRegisterTeamName"
          >
            <Input placeholder="Only needed when registering" />
          </Form.Item>
          <Form.Item label="Account">
            <Space>
              <Button
                type="primary"
                loading={cloudLoading}
                onClick={() => handleCloudAuth('login')}
              >
                Login
              </Button>
              <Button
                loading={cloudLoading}
                onClick={() => handleCloudAuth('register')}
              >
                Register
              </Button>
            </Space>
          </Form.Item>
          <Form.Item
            label="Team"
            name={['cloudSync', 'workspaceId']}
          >
            <Select
              options={teamOptions}
              placeholder="Login first, then choose a team"
              onFocus={() => {
                const values = form.getFieldsValue(true);
                if (values.cloudSync?.apiBaseUrl && values.cloudSync?.accessToken) {
                  fetchTeams(values.cloudSync.apiBaseUrl, values.cloudSync.accessToken).catch(error =>
                    messageApi.error((error as Error).message),
                  );
                }
              }}
            />
          </Form.Item>
          <Form.Item
            label="Device Name"
            name={['cloudSync', 'deviceName']}
          >
            <Input placeholder="mac-a / win-b" />
          </Form.Item>
          <Form.Item
            label="Access Token"
            name={['cloudSync', 'accessToken']}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Card>
      {/* <div className="content-footer pl-24">
        <Button
          type="primary"
          className="w-20"
          onClick={() => handleSave(formValue)}
        >
          {t('footer_ok')}
        </Button>
      </div> */}
    </>
  );
};
export default Settings;
