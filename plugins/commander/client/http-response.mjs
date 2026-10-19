/** Decode one API response without hiding transport failures or retrying requests. */
export async function readJsonResponse(response, requestUrl) {
  const pathname = new URL(requestUrl).pathname;
  const context = 'HTTP ' + response.status + ' · ' + pathname;
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    const error = new Error((response.ok ? '接口返回格式异常' : '请求失败') + '（' + context + '）', { cause });
    error.code = response.ok ? 'INVALID_JSON_RESPONSE' : 'HTTP_ERROR';
    error.status = response.status;
    error.pathname = pathname;
    throw error;
  }
  if (!response.ok) {
    const detail = typeof value?.error === 'string' ? value.error : value?.error?.message;
    const message = typeof detail === 'string' ? detail.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const error = new Error('请求失败' + (message ? '：' + message : '') + '（' + context + '）');
    error.code = 'HTTP_ERROR';
    error.status = response.status;
    error.pathname = pathname;
    throw error;
  }
  if (value === null || typeof value !== 'object') {
    const error = new Error('接口返回格式异常（' + context + '）');
    error.code = 'INVALID_JSON_RESPONSE';
    error.status = response.status;
    error.pathname = pathname;
    throw error;
  }
  return value;
}
