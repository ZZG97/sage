#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const tools = [
  {
    name: 'maps_regeocode',
    description: '将一个高德经纬度坐标转换为行政区划地址信息',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '经纬度，格式：经度,纬度' },
      },
      required: ['location'],
    },
  },
  {
    name: 'maps_geo',
    description: '将详细地址或地标名称转换为高德经纬度坐标',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: '待解析的结构化地址或地标' },
        city: { type: 'string', description: '指定查询城市' },
      },
      required: ['address'],
    },
  },
  {
    name: 'maps_ip_location',
    description: '根据 IP 地址定位所在位置',
    inputSchema: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: 'IP 地址' },
      },
      required: ['ip'],
    },
  },
  {
    name: 'maps_weather',
    description: '根据城市名称或 adcode 查询天气预报',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名称或 adcode' },
      },
      required: ['city'],
    },
  },
  {
    name: 'maps_search_detail',
    description: '查询 POI ID 的详细信息',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '关键词搜索或周边搜索返回的 POI ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'maps_bicycling',
    description: '骑行路径规划，最大支持 500km',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '出发点经纬度，格式：经度,纬度' },
        destination: { type: 'string', description: '目的地经纬度，格式：经度,纬度' },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'maps_direction_walking',
    description: '步行路径规划，支持 100km 以内步行方案',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '出发点经纬度，格式：经度,纬度' },
        destination: { type: 'string', description: '目的地经纬度，格式：经度,纬度' },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'maps_direction_driving',
    description: '驾车路径规划',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '出发点经纬度，格式：经度,纬度' },
        destination: { type: 'string', description: '目的地经纬度，格式：经度,纬度' },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'maps_direction_transit_integrated',
    description: '公交、地铁、火车等公共交通综合路径规划',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '出发点经纬度，格式：经度,纬度' },
        destination: { type: 'string', description: '目的地经纬度，格式：经度,纬度' },
        city: { type: 'string', description: '起点城市' },
        cityd: { type: 'string', description: '终点城市' },
      },
      required: ['origin', 'destination', 'city', 'cityd'],
    },
  },
  {
    name: 'maps_distance',
    description: '距离测量，支持驾车、步行、直线距离',
    inputSchema: {
      type: 'object',
      properties: {
        origins: { type: 'string', description: '起点经纬度，可用 | 分隔多个坐标' },
        destination: { type: 'string', description: '终点经纬度，格式：经度,纬度' },
        type: { type: 'string', description: '1 驾车，0 直线，3 步行' },
      },
      required: ['origins', 'destination'],
    },
  },
  {
    name: 'maps_text_search',
    description: '关键词搜索 POI',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: '搜索关键词' },
        city: { type: 'string', description: '查询城市' },
        types: { type: 'string', description: 'POI 类型' },
        citylimit: { type: 'string', description: '是否限制城市范围，true/false' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'maps_around_search',
    description: '周边搜索 POI',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '中心点经纬度，格式：经度,纬度' },
        radius: { type: 'string', description: '搜索半径，单位米' },
        keywords: { type: 'string', description: '搜索关键词' },
      },
      required: ['location'],
    },
  },
];

const handlers = {
  async maps_regeocode({ location }) {
    const data = await amap('/v3/geocode/regeo', { location });
    return {
      province: data.regeocode?.addressComponent?.province,
      city: data.regeocode?.addressComponent?.city,
      district: data.regeocode?.addressComponent?.district,
      formatted_address: data.regeocode?.formatted_address,
    };
  },

  async maps_geo({ address, city }) {
    const data = await amap('/v3/geocode/geo', { address, city });
    return {
      return: (data.geocodes || []).map((geo) => ({
        country: geo.country,
        province: geo.province,
        city: geo.city,
        citycode: geo.citycode,
        district: geo.district,
        street: geo.street,
        number: geo.number,
        adcode: geo.adcode,
        location: geo.location,
        level: geo.level,
      })),
    };
  },

  async maps_ip_location({ ip }) {
    const data = await amap('/v3/ip', { ip });
    return {
      province: data.province,
      city: data.city,
      adcode: data.adcode,
      rectangle: data.rectangle,
    };
  },

  async maps_weather({ city }) {
    const data = await amap('/v3/weather/weatherInfo', { city, extensions: 'all' });
    const forecast = data.forecasts?.[0];
    return {
      city: forecast?.city,
      adcode: forecast?.adcode,
      forecasts: forecast?.casts || [],
    };
  },

  async maps_search_detail({ id }) {
    const data = await amap('/v3/place/detail', { id });
    const poi = data.pois?.[0] || {};
    return {
      id: poi.id,
      name: poi.name,
      location: poi.location,
      address: poi.address,
      business_area: poi.business_area,
      city: poi.cityname,
      type: poi.type,
      alias: poi.alias,
      photos: poi.photos?.[0],
      ...(poi.biz_ext || {}),
    };
  },

  async maps_bicycling({ origin, destination }) {
    const data = await amap('/v4/direction/bicycling', { origin, destination }, 'v4');
    return {
      data: {
        origin: data.data?.origin,
        destination: data.data?.destination,
        paths: (data.data?.paths || []).map(routePath),
      },
    };
  },

  async maps_direction_walking({ origin, destination }) {
    const data = await amap('/v3/direction/walking', { origin, destination });
    return {
      route: {
        origin: data.route?.origin,
        destination: data.route?.destination,
        paths: (data.route?.paths || []).map(routePath),
      },
    };
  },

  async maps_direction_driving({ origin, destination }) {
    const data = await amap('/v3/direction/driving', { origin, destination });
    return {
      route: {
        origin: data.route?.origin,
        destination: data.route?.destination,
        paths: (data.route?.paths || []).map((path) => ({
          path: path.path,
          ...routePath(path),
        })),
      },
    };
  },

  async maps_direction_transit_integrated({ origin, destination, city = '', cityd = '' }) {
    const data = await amap('/v3/direction/transit/integrated', { origin, destination, city, cityd });
    return {
      route: {
        origin: data.route?.origin,
        destination: data.route?.destination,
        distance: data.route?.distance,
        transits: (data.route?.transits || []).map((transit) => ({
          duration: transit.duration,
          walking_distance: transit.walking_distance,
          segments: (transit.segments || []).map((segment) => ({
            walking: {
              origin: segment.walking?.origin,
              destination: segment.walking?.destination,
              distance: segment.walking?.distance,
              duration: segment.walking?.duration,
              steps: (segment.walking?.steps || []).map(walkStep),
            },
            bus: {
              buslines: (segment.bus?.buslines || []).map((busline) => ({
                name: busline.name,
                departure_stop: { name: busline.departure_stop?.name },
                arrival_stop: { name: busline.arrival_stop?.name },
                distance: busline.distance,
                duration: busline.duration,
                via_stops: (busline.via_stops || []).map((stop) => ({ name: stop.name })),
              })),
            },
            entrance: { name: segment.entrance?.name },
            exit: { name: segment.exit?.name },
            railway: {
              name: segment.railway?.name,
              trip: segment.railway?.trip,
            },
          })),
        })),
      },
    };
  },

  async maps_distance({ origins, destination, type = '1' }) {
    const data = await amap('/v3/distance', { origins, destination, type });
    return {
      results: (data.results || []).map((result) => ({
        origin_id: result.origin_id,
        dest_id: result.dest_id,
        distance: result.distance,
        duration: result.duration,
      })),
    };
  },

  async maps_text_search({ keywords, city = '', types = '', citylimit = 'false' }) {
    const data = await amap('/v3/place/text', { keywords, city, types, citylimit });
    return {
      suggestion: {
        keywords: data.suggestion?.keywords,
        cities: (data.suggestion?.cities || data.suggestion?.ciytes || []).map((cityItem) => ({
          name: cityItem.name,
        })),
      },
      pois: (data.pois || []).map(simplePoi),
    };
  },

  async maps_around_search({ location, radius = '1000', keywords = '' }) {
    const data = await amap('/v3/place/around', { location, radius, keywords });
    return {
      pois: (data.pois || []).map(simplePoi),
    };
  },
};

function routePath(path) {
  return {
    distance: path.distance,
    duration: path.duration,
    steps: (path.steps || []).map((step) => ({
      instruction: step.instruction,
      road: step.road,
      distance: step.distance,
      orientation: step.orientation,
      duration: step.duration,
    })),
  };
}

function walkStep(step) {
  return {
    instruction: step.instruction,
    road: step.road,
    distance: step.distance,
    action: step.action,
    assistant_action: step.assistant_action,
  };
}

function simplePoi(poi) {
  return {
    id: poi.id,
    name: poi.name,
    address: poi.address,
    location: poi.location,
    typecode: poi.typecode,
    type: poi.type,
    city: poi.cityname,
    adname: poi.adname,
    photos: poi.photos?.[0],
  };
}

async function amap(path, params, apiVersion = 'v3') {
  const apiKey = getApiKey();
  const url = new URL(`https://restapi.amap.com${path}`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('source', 'sage_mcp');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url);
  const data = await response.json();
  const ok = apiVersion === 'v4' ? data.errcode === 0 : data.status === '1';

  if (!ok) {
    const message = data.info || data.infocode || data.errmsg || data.errdetail || 'AMap API request failed';
    throw new Error(message);
  }

  return data;
}

function getApiKey() {
  if (process.env.AMAP_MAPS_API_KEY) return process.env.AMAP_MAPS_API_KEY;

  for (const file of [
    '/Users/zhangzhiguo/workspace/sage/.env',
    '/Users/zhangzhiguo/workspace/sage/.env.dev',
  ]) {
    try {
      const value = readEnvValue(file, 'AMAP_MAPS_API_KEY');
      if (value) return value;
    } catch {
      // Ignore missing env files; the tool call will return a clear error below.
    }
  }

  throw new Error('AMAP_MAPS_API_KEY is not set in process env, .env, or .env.dev');
}

function readEnvValue(file, key) {
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const index = line.indexOf('=');
    if (index <= 0) continue;

    const name = line.slice(0, index).trim();
    if (name !== key) continue;

    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;

  try {
    if (method === 'initialize') {
      result(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sage-amap-mcp', version: '0.1.0' },
      });
      return;
    }

    if (method === 'notifications/initialized') return;

    if (method === 'tools/list') {
      result(id, { tools });
      return;
    }

    if (method === 'tools/call') {
      const handler = handlers[params?.name];
      if (!handler) {
        result(id, {
          content: [{ type: 'text', text: `Unknown tool: ${params?.name}` }],
          isError: true,
        });
        return;
      }

      const value = await handler(params?.arguments || {});
      result(id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        isError: false,
      });
      return;
    }

    if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (id !== undefined) {
      result(id, {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      });
    }
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;

    try {
      void handle(JSON.parse(line));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
    }
  }
});
