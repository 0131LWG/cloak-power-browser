import {Button, Card, Divider, Form, Input, Space, Switch, Typography} from 'antd';
import {CommonBridge, SyncBridge} from '#preload';
import {useEffect, useState} from 'react';
import type {SettingOptions} from '../../../../shared/types/common';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router-dom';
import {clearCloudSession} from '/@/utils/cloud-auth';

type FieldType = {
  profileCachePath: string;
  useLocalChrome: boolean;
  localChromePath: string;
  chromiumBinPath: string;
  automationConnect: boolean;
  cloudSync?: SettingOptions['cloudSync'];
};

type SettingsFormValues = SettingOptions;

const {Text} = Typography;

const Settings = () => {
  const [formValue, setFormValue] = useState<SettingOptions>({
    profileCachePath: '',
    useLocalChrome: true,
    localChromePath: '',
    chromiumBinPath: '',
    automationConnect: false,
  });
  const [form] = Form.useForm();
  const {t} = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    const settings = await CommonBridge.getSettings();
    setFormValue(settings);
    form.setFieldsValue(settings);
  };

  const handleSave = async (values: SettingsFormValues) => {
    await CommonBridge.saveSettings(values);
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
    const newFormValue = {
      ...formValue,
      ...changed,
    };
    setFormValue(newFormValue);
    handleSave(newFormValue);
  };

  // type FieldType = SettingOptions;

  return (
    <>
      <Card
        className="content-card p-6"
        bordered={false}
      >
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
          <Form.Item label="Account">
            <Space direction="vertical" size={2}>
              <Text>当前用户：{formValue.cloudSync?.userId || '-'}</Text>
              <Text>当前团队：{formValue.cloudSync?.workspaceId || '-'}</Text>
            </Space>
          </Form.Item>
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
          <Form.Item label="Session">
            <Space>
              <Button
                type="primary"
                onClick={() => navigate('/auth/team-select')}
              >
                切换团队
              </Button>
              <Button
                danger
                onClick={() => {
                  clearCloudSession().then(() => navigate('/auth/login', {replace: true}));
                }}
              >
                退出登录
              </Button>
            </Space>
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
