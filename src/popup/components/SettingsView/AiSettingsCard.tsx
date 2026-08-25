import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import MenuItem from '@mui/material/MenuItem';
import Alert from '@mui/material/Alert';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DashboardCard from '../shared/DashboardCard';
import { AiProviderConfig } from '../../../types/ai';
import { createDefaultAiProviderConfig, getAiProviderConfig, listAiModels, saveAiProviderConfig, testAiConnection } from '../../../services/ai-service';
import { isFirefox } from '../../../utils/browser-compat';

const AiSettingsCard: React.FC = () => {
  const [config, setConfig] = useState<AiProviderConfig>(createDefaultAiProviderConfig());
  const [models, setModels] = useState<string[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ severity: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    void getAiProviderConfig().then(setConfig).catch(() => setMessage({ severity: 'error', text: '加载 AI 配置失败' })).finally(() => setLoading(false));
  }, []);

  const update = <K extends keyof AiProviderConfig>(key: K, value: AiProviderConfig[K]) => {
    setConfig(current => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await saveAiProviderConfig(config);
      setConfig(saved);
      setMessage({ severity: 'success', text: 'AI 配置已保存；API Key 仅保存在本地扩展存储' });
    } catch (error) {
      setMessage({ severity: 'error', text: error instanceof Error ? error.message : 'AI 配置保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const saved = await saveAiProviderConfig(config);
      setConfig(saved);
      const result = await testAiConnection(saved);
      setModels(result.models);
      setMessage({ severity: 'success', text: result.modelCount > 0 ? '连接成功，已获取 ' + result.modelCount + ' 个模型' : '连接成功' });
    } catch (error) {
      setMessage({ severity: 'error', text: error instanceof Error ? error.message : 'AI API 测试失败' });
    } finally {
      setTesting(false);
    }
  };

  const handleModels = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const result = await listAiModels(config);
      setModels(result);
      setMessage({ severity: 'info', text: result.length ? '模型列表已更新' : '服务未返回模型列表，可手工填写模型' });
    } catch (error) {
      setMessage({ severity: 'error', text: error instanceof Error ? error.message : '获取模型列表失败' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <DashboardCard
      title="AI 智能分类"
      icon={<AutoAwesomeIcon fontSize="small" sx={{ color: 'primary.main' }} />}
    >
      <Stack spacing={1.25}>
        <Typography variant="caption" color="text.secondary">
          配置你自己的 API 地址、Key、协议和模型。未配置时不会发送任何书签数据。
        </Typography>
        {isFirefox() && (
          <Alert severity="warning" sx={{ py: 0.25 }}>
            Firefox 当前使用 MV2。自定义 API 地址需要服务端允许扩展跨域（CORS）；插件不会静默申请任意网站权限。
          </Alert>
        )}
        <FormControlLabel
          control={<Switch size="small" checked={config.enabled} onChange={event => update('enabled', event.target.checked)} />}
          label="启用 AI 分类"
        />
        {message && <Alert severity={message.severity} sx={{ py: 0.25 }}>{message.text}</Alert>}
        <TextField
          size="small"
          label="API 地址"
          value={config.endpoint}
          onChange={event => update('endpoint', event.target.value)}
          placeholder="https://example.com"
          fullWidth
          disabled={loading || saving || testing}
        />
        <TextField
          size="small"
          label="API Key"
          type={showKey ? 'text' : 'password'}
          value={config.apiKey}
          onChange={event => update('apiKey', event.target.value)}
          placeholder="可留空（由服务决定）"
          fullWidth
          disabled={loading || saving || testing}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton size="small" onClick={() => setShowKey(value => !value)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>
                  {showKey ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                </IconButton>
              </InputAdornment>
            ),
          }}
        />
        <TextField
          select
          size="small"
          label="协议"
          value={config.protocol}
          onChange={event => update('protocol', event.target.value as AiProviderConfig['protocol'])}
          fullWidth
          disabled={loading || saving || testing}
        >
          <MenuItem value="responses">Responses API</MenuItem>
          <MenuItem value="chat-completions">Chat Completions</MenuItem>
          <MenuItem value="custom">自定义兼容请求</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          label="认证方式"
          value={config.authType}
          onChange={event => update('authType', event.target.value as AiProviderConfig['authType'])}
          fullWidth
          disabled={loading || saving || testing}
        >
          <MenuItem value="bearer">Authorization: Bearer</MenuItem>
          <MenuItem value="api-key-header">自定义 API Key Header</MenuItem>
          <MenuItem value="none">不发送认证头</MenuItem>
        </TextField>
        {config.authType === 'api-key-header' && (
          <TextField
            size="small"
            label="API Key Header"
            value={config.apiKeyHeader}
            onChange={event => update('apiKeyHeader', event.target.value)}
            placeholder="X-API-Key"
            fullWidth
            disabled={loading || saving || testing}
          />
        )}
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            size="small"
            label="模型"
            value={config.model}
            onChange={event => update('model', event.target.value)}
            fullWidth
            disabled={loading || saving || testing}
          />
          <Button variant="outlined" onClick={handleModels} disabled={loading || saving || testing || !config.endpoint}>
            获取列表
          </Button>
        </Box>
        {models.length > 0 && (
          <TextField
            select
            size="small"
            label="已发现模型"
            value={models.includes(config.model) ? config.model : ''}
            onChange={event => update('model', event.target.value)}
            fullWidth
          >
            <MenuItem value="">不切换</MenuItem>
            {models.map(model => <MenuItem key={model} value={model}>{model}</MenuItem>)}
          </TextField>
        )}
        <TextField
          size="small"
          label="优化提示词（可选）"
          value={config.systemPrompt}
          onChange={event => update('systemPrompt', event.target.value)}
          multiline
          minRows={2}
          maxRows={5}
          fullWidth
          disabled={loading || saving || testing}
        />
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            size="small"
            type="number"
            label="批量大小"
            value={config.batchSize}
            onChange={event => update('batchSize', Number(event.target.value))}
            inputProps={{ min: 10, max: 200 }}
            sx={{ flex: 1 }}
          />
          <TextField
            size="small"
            type="number"
            label="分类数"
            value={config.maxCategories}
            onChange={event => update('maxCategories', Number(event.target.value))}
            inputProps={{ min: 3, max: 50 }}
            sx={{ flex: 1 }}
          />
        </Box>
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button variant="outlined" onClick={handleTest} disabled={loading || saving || testing || !config.endpoint}>
            {testing ? '测试中…' : '测试 API 连通性'}
          </Button>
          <Button variant="contained" onClick={handleSave} disabled={loading || saving || testing}>
            {saving ? '保存中…' : '保存配置'}
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary">
          隐私：书签请求只包含标题、URL、域名和文件夹路径；API Key 仅作为认证头发送给你配置的服务，不会进入书签提示词、同步存储、配置导出或 GitHub 备份。
        </Typography>
      </Stack>
    </DashboardCard>
  );
};

export default AiSettingsCard;
