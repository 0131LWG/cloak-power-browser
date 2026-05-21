import {Form, Input, Select, Row, Col, Space, Typography, message, InputNumber, Divider} from 'antd';
import AddableSelect from '/@/components/addable-select';
import {useEffect, useState} from 'react';
import type {DB} from '../../../../../../shared/types/db';
import {GroupBridge, TagBridge, ProxyBridge, WindowBridge} from '#preload';
import {TAG_COLORS} from '/@/constants';
import {useTranslation} from 'react-i18next';

const {TextArea} = Input;
const {Text} = Typography;

interface RuntimeOption {
  tag: string;
  asset: string;
  recommended?: boolean;
  downloaded?: boolean;
  notes?: string;
}

const browserEngineOptions = [
  {label: '原 Chromium', value: 'chromium'},
  {label: '本机 Chrome', value: 'chrome'},
  {label: 'CloakBrowser', value: 'cloakbrowser'},
];

const platformOptions = [
  {label: 'macOS', value: 'macos'},
  {label: 'Windows', value: 'windows'},
  {label: 'Linux', value: 'linux'},
];

const webrtcOptions = [
  {label: 'Auto', value: 'auto'},
  {label: 'Default', value: 'default'},
  {label: 'Disabled', value: 'disabled'},
];

const WindowEditForm = ({
  formValue,
  formChangeCallback,
  loading,
}: {
  loading: boolean;
  formValue: DB.Window;
  formChangeCallback: (changed: DB.Window, data: DB.Window) => void;
}) => {
  const [form] = Form.useForm();
  const [groups, setGroups] = useState<DB.Group[]>([]);
  const [tags, setTags] = useState<DB.Tag[]>([]);
  const [proxies, setProxies] = useState<DB.Proxy[]>([]);
  const [runtimePlatform, setRuntimePlatform] = useState('');
  const [cloakBrowserRuntimes, setCloakBrowserRuntimes] = useState<RuntimeOption[]>([]);
  const {t} = useTranslation();
  const [messageApi, contextHolder] = message.useMessage({
    duration: 3,
    top: 100,
  });

  useEffect(() => {
    if (JSON.stringify(formValue) === '{}') {
      form?.resetFields();
    } else {
      form?.setFieldsValue(normalizeFormValue(formValue));
    }
  }, [formValue]);

  const fetchGroups = async () => {
    const groups = await GroupBridge?.getAll();
    setGroups(groups);
  };
  const fetchTags = async () => {
    const tags = await TagBridge?.getAll();
    setTags(tags);
  };
  const fetchProxies = async () => {
    const proxies = await ProxyBridge?.getAll();
    setProxies(proxies);
  };
  const fetchCloakBrowserRuntimes = async () => {
    const result = await WindowBridge?.getCloakBrowserRuntimes();
    setRuntimePlatform(result?.platform || '');
    setCloakBrowserRuntimes(result?.runtimes || []);
  };

  useEffect(() => {
    fetchGroups();
    fetchTags();
    fetchProxies();
    fetchCloakBrowserRuntimes();
  }, []);

  const onAddGroup = async (name: string) => {
    const createdIds = await GroupBridge?.create({name});
    if (createdIds.length) {
      await fetchGroups();
      return true;
    } else {
      return false;
    }
  };

  const onRemoveGroup = async (id: number | undefined | string) => {
    console.log('onRemoveGroup', id);
    const res = await GroupBridge?.delete(Number(id));
    if (res.success) {
      await fetchGroups();
    } else {
      messageApi.error(res.message);
    }
  };

  const onAddTag = async (name: string) => {
    const createdIds = await TagBridge?.create({
      name,
      color: TAG_COLORS[tags.length % TAG_COLORS.length],
    });
    if (createdIds.length) {
      await fetchTags();
      return true;
    } else {
      return false;
    }
  };

  const onRemoveTag = async (id: number | undefined | string) => {
    const res = await TagBridge?.delete(Number(id));
    if (res.success) {
      await fetchTags();
    } else {
      messageApi.error(res.message);
    }
  };

  const filterProxyOption = (input: string, option?: DB.Proxy) => {
    return (
      (option?.ip ?? '').toLowerCase().includes(input.toLowerCase()) ||
      (option?.proxy ?? '').toLowerCase().includes(input.toLowerCase()) ||
      (option?.remark ?? '').toLowerCase().includes(input.toLowerCase())
    );
  };

  type FieldType = DB.Window;
  const selectedBrowserEngine = Form.useWatch('browser_engine', form);

  const emitProgrammaticChange = (changed: Partial<DB.Window>) => {
    const data = form.getFieldsValue(true) as DB.Window;
    formChangeCallback(changed as DB.Window, data);
  };

  useEffect(() => {
    if (!runtimePlatform) {
      return;
    }

    if (!selectedBrowserEngine) {
      form.setFieldValue('browser_engine', 'cloakbrowser');
      form.setFieldValue('browser_runtime_platform', runtimePlatform);
      const recommended = cloakBrowserRuntimes.find(runtime => runtime.recommended);
      const defaultVersion = recommended?.tag || cloakBrowserRuntimes[0]?.tag;
      if (defaultVersion) {
        form.setFieldValue('browser_version', defaultVersion);
      }
      emitProgrammaticChange({
        browser_engine: 'cloakbrowser',
        browser_runtime_platform: runtimePlatform,
        ...(defaultVersion ? {browser_version: defaultVersion} : {}),
      });
      return;
    }

    if (selectedBrowserEngine !== 'cloakbrowser') {
      return;
    }

    const patch: Partial<DB.Window> = {};

    const currentPlatform = form.getFieldValue('browser_runtime_platform');
    if (currentPlatform !== runtimePlatform) {
      form.setFieldValue('browser_runtime_platform', runtimePlatform);
      patch.browser_runtime_platform = runtimePlatform;
    }

    const currentVersion = form.getFieldValue('browser_version');
    if (!currentVersion) {
      const recommended = cloakBrowserRuntimes.find(runtime => runtime.recommended);
      const defaultVersion = recommended?.tag || cloakBrowserRuntimes[0]?.tag;
      if (defaultVersion) {
        form.setFieldValue('browser_version', defaultVersion);
        patch.browser_version = defaultVersion;
      }
    }

    if (Object.keys(patch).length) {
      emitProgrammaticChange(patch);
    }
  }, [selectedBrowserEngine, runtimePlatform, cloakBrowserRuntimes, form, formChangeCallback]);

  return (
    <Form
      layout="horizontal"
      disabled={loading}
      form={form}
      size="large"
      initialValues={formValue}
      onValuesChange={formChangeCallback}
      labelCol={{span: 6}}
    >
      {contextHolder}
      <Form.Item<FieldType>
        label={t('window_edit_form_name')}
        name="name"
      >
        <Input />
      </Form.Item>

      <Form.Item<FieldType>
        name="group_id"
        label={t('window_edit_form_group')}
      >
        <AddableSelect
          options={groups}
          onAddItem={onAddGroup}
          addBtnLabel="Add Group"
          onRemoveItem={onRemoveGroup}
        ></AddableSelect>
      </Form.Item>

      <Form.Item<FieldType>
        name="tags"
        label={t('window_edit_form_tags')}
      >
        <AddableSelect
          mode="multiple"
          options={tags}
          value={formValue.tags as string[]}
          onAddItem={onAddTag}
          addBtnLabel="Add Tag"
          onRemoveItem={onRemoveTag}
        ></AddableSelect>
      </Form.Item>

      {/* <Form.Item<FieldType>
        name="ua"
        label="UserAgent"
      >
        <TextArea
          rows={4}
          placeholder="UserAgent"
        />
      </Form.Item> */}

      <Form.Item<FieldType>
        name="remark"
        label={t('window_edit_form_remark')}
      >
        <TextArea rows={4} />
      </Form.Item>

      <Form.Item<FieldType>
        name="proxy_id"
        label={t('window_edit_form_proxy')}
      >
        <Select
          options={proxies}
          allowClear
          showSearch
          filterOption={filterProxyOption}
          fieldNames={{label: 'proxy', value: 'id'}}
          optionRender={option => {
            return (
              <Row justify="space-between">
                <Col span={2}>
                  <Text code>#{option.data.id}</Text>
                </Col>

                <Col span={16}>
                  <Space direction="vertical">
                    <Text
                      style={{width: 200}}
                      ellipsis={{tooltip: `${option.data.proxy}  ${option.data.remark}`}}
                    >
                      {option.data.proxy}
                    </Text>
                    {option.data.remark && (
                      <Text
                        mark
                        style={{width: 200}}
                        ellipsis={{tooltip: `${option.data.proxy}  ${option.data.remark}`}}
                      >
                        {option.data.remark}
                      </Text>
                    )}
                  </Space>
                </Col>
                <Col span={1}>
                  <span
                    role="img"
                    aria-label={option.data.proxy}
                  >
                    {option.data.usageCount}
                  </span>
                </Col>
              </Row>
            );
          }}
        ></Select>
      </Form.Item>

      <Form.Item<FieldType>
        label={t('window_edit_form_profile_id')}
        name="profile_id"
      >
        <Input />
      </Form.Item>

      <Divider orientation="left">Browser Runtime</Divider>

      <Form.Item<FieldType>
        label="Kernel"
        name="browser_engine"
        tooltip="选择这个 profile 打开时使用的浏览器内核。"
      >
        <Select
          placeholder="CloakBrowser"
          options={browserEngineOptions}
        />
      </Form.Item>

      {selectedBrowserEngine === 'cloakbrowser' && (
        <>
          <Form.Item<FieldType>
            label="Platform"
            name="browser_runtime_platform"
            tooltip="运行时平台由当前系统自动决定；macOS 和 Windows 的可选版本不同。"
          >
            <Input
              disabled
              placeholder={runtimePlatform}
            />
          </Form.Item>

          <Form.Item<FieldType>
            label="Version"
            name="browser_version"
            tooltip="未下载的版本会在打开窗口前自动从 CloakBrowser GitHub Releases 下载。"
          >
            <Select
              allowClear
              placeholder="Recommended"
              options={cloakBrowserRuntimes.map(runtime => ({
                label: `${runtime.tag}${runtime.recommended ? ' · 推荐' : ''}${
                  runtime.downloaded ? ' · 已下载' : ' · 未下载'
                }`,
                value: runtime.tag,
              }))}
              notFoundContent="当前平台没有配置 CloakBrowser runtime"
            />
          </Form.Item>
        </>
      )}

      <Divider orientation="left">CloakBrowser Fingerprint</Divider>

      <Form.Item
        label="Seed"
        name={['fingerprint', 'fingerprintSeed']}
        tooltip="同一个 profile 建议使用固定 seed；留空时会根据 profile_id 自动生成。"
      >
        <Input placeholder="例如 62655" />
      </Form.Item>

      <Form.Item
        label="Platform"
        name={['fingerprint', 'platform']}
      >
        <Select
          allowClear
          placeholder="默认使用创建窗口的设备平台"
          options={platformOptions}
        />
      </Form.Item>

      <Form.Item
        label="Timezone"
        name={['fingerprint', 'timezone']}
        tooltip="留空时会根据代理 IP 自动推断。"
      >
        <Input placeholder="例如 Asia/Tokyo" />
      </Form.Item>

      <Form.Item
        label="Locale"
        name={['fingerprint', 'locale']}
        tooltip="留空时会根据代理国家自动推断。"
      >
        <Input placeholder="例如 ja-JP" />
      </Form.Item>

      <Form.Item
        label="Screen"
      >
        <Space.Compact block>
          <Form.Item
            name={['fingerprint', 'screenWidth']}
            noStyle
          >
            <InputNumber
              min={320}
              max={7680}
              style={{width: '50%'}}
              placeholder="Width"
            />
          </Form.Item>
          <Form.Item
            name={['fingerprint', 'screenHeight']}
            noStyle
          >
            <InputNumber
              min={240}
              max={4320}
              style={{width: '50%'}}
              placeholder="Height"
            />
          </Form.Item>
        </Space.Compact>
      </Form.Item>

      <Form.Item
        label="WebRTC"
        name={['fingerprint', 'webrtcPolicy']}
      >
        <Select
          allowClear
          placeholder="Auto"
          options={webrtcOptions}
        />
      </Form.Item>

      {/* <Form.Item<FieldType>
        name="cookie"
        label="Cookie"
      >
        <TextArea
          rows={7}
          placeholder={
            'Cookie, eg: [{"name":"O365Consumer","value":"1","domain":"outlook.live.com","path":"","httpOnly":true,"secure":true,"session":true,"expires":1744367913,"sameSite":"no_restriction"}]'
          }
        />
      </Form.Item> */}
    </Form>
  );
};

export default WindowEditForm;

const normalizeFormValue = (value: DB.Window) => {
  if (!value?.fingerprint || typeof value.fingerprint !== 'string') {
    return value;
  }

  try {
    return {
      ...value,
      fingerprint: JSON.parse(value.fingerprint),
    };
  } catch {
    return {
      ...value,
      fingerprint: {},
    };
  }
};
