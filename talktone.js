async function operator(proxies = [], targetPlatform, context) {
  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1'
  const http_meta_port = $arguments.http_meta_port ?? 9876
  const http_meta_protocol = $arguments.http_meta_protocol ?? 'http'
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000)
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)
  const talktonePrefix = $arguments.talktone_prefix ?? '[TalkTone] '
  const method = $arguments.method || 'get'

  const talktoneUrl = 'https://www.talkatone.com/' // TalkTone 网址
  const ipApiUrl = 'https://ipinfo.io/' // IP 归属地查询 API
  const $ = $substore

  const internalProxies = []
  proxies.map((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key]
          }
        }
        internalProxies.push({ ...node, _proxies_index: index })
      }
    } catch (e) {
      $.error(e)
    }
  })

  $.info(`核心支持节点数: ${internalProxies.length}/${proxies.length}`)
  if (!internalProxies.length) return proxies

  const http_meta_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout

  let http_meta_pid
  let http_meta_ports = []
  const res = await http({
    retries: 0,
    method: 'post',
    url: `${http_meta_api}/start`,
    headers: { 'Content-type': 'application/json' },
    body: JSON.stringify({ proxies: internalProxies, timeout: http_meta_timeout }),
  })
  let body = res.body
  try {
    body = JSON.parse(body)
  } catch (e) {}

  const { ports, pid } = body
  if (!pid || !ports) {
    throw new Error(`======== HTTP META 启动失败 ====\n${body}`)
  }
  http_meta_pid = pid
  http_meta_ports = ports
  $.info(`\n======== HTTP META 启动 ====\n[端口] ${ports}\n[PID] ${pid}\n[超时] ${http_meta_timeout / 1000}s`)

  $.info(`等待 ${http_meta_start_delay / 1000} 秒后开始检测`)
  await $.wait(http_meta_start_delay)

  const concurrency = parseInt($arguments.concurrency || 10)
  await executeAsyncTasks(
    internalProxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  try {
    await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: { 'Content-type': 'application/json' },
      body: JSON.stringify({ pid: [http_meta_pid] }),
    })
    $.info(`\n======== HTTP META 关闭 ====\n`)
  } catch (e) {
    $.error(e)
  }

  return proxies

  async function check(proxy) {
    try {
      const index = internalProxies.indexOf(proxy)
      const startedAt = Date.now()

      // **步骤 1: 获取代理 IP**
      const ipRes = await http({
        proxy: `http://${http_meta_host}:${http_meta_ports[index]}`,
        method,
        url: 'https://api64.ipify.org?format=json',
      })
      const ip = JSON.parse(ipRes.body).ip
      $.info(`[${proxy.name}] IP: ${ip}`)

      // **步骤 2: 查询 IP 归属地**
      const geoRes = await http({
        proxy: `http://${http_meta_host}:${http_meta_ports[index]}`,
        method,
        url: `${ipApiUrl}${ip}/json`,
      })
      const geoInfo = JSON.parse(geoRes.body)
      $.info(`[${proxy.name}] 归属地: ${geoInfo.country}, ${geoInfo.region}`)

      // 只有美国 IP 才继续检测
      if (geoInfo.country !== 'US') {
        $.info(`[${proxy.name}] 非美国 IP，跳过检测`)
        return
      }

      // **步骤 3: 访问 TalkTone 服务器**
      const talktoneRes = await http({
        proxy: `http://${http_meta_host}:${http_meta_ports[index]}`,
        method,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        url: talktoneUrl,
      })
      const status = parseInt(talktoneRes.status || talktoneRes.statusCode || 200)

      let latency = `${Date.now() - startedAt}ms`
      $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`)

      // **TalkTone 可用的条件**
      if (status === 200) {
        proxies[proxy._proxies_index].name = `${talktonePrefix}${proxies[proxy._proxies_index].name}`
        proxies[proxy._proxies_index]._talktone = true
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
    }
  }

  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || 5000)
    let count = 0

    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < 1) {
          count++
          await $.wait(1000)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        let index = 0

        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++
            const currentTask = tasks[taskIndex]
            running++

            currentTask()
              .finally(() => {
                running--
                executeNextTask()
              })
          }

          if (running === 0) {
            return resolve()
          }
        }

        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}
