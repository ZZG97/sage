// 定时任务：每日天气播报（OpenWeatherMap）
import type { TaskContext } from '../scheduler';

const API_BASE = 'https://api.openweathermap.org/data/2.5';
const DEFAULT_CITY = 'Beijing';
const DEFAULT_LAT = '39.9042';
const DEFAULT_LON = '116.4074';

interface WeatherData {
  weather: { description: string; icon: string }[];
  main: { temp: number; feels_like: number; humidity: number; temp_min: number; temp_max: number };
  wind: { speed: number };
  name: string;
}

interface ForecastItem {
  dt: number;
  main: { temp: number; temp_min: number; temp_max: number };
  weather: { description: string }[];
  pop: number; // 降水概率
}

interface ForecastData {
  list: ForecastItem[];
}

// 天气图标映射
const weatherEmoji: Record<string, string> = {
  '01': '☀️', '02': '⛅', '03': '☁️', '04': '☁️',
  '09': '🌧️', '10': '🌦️', '11': '⛈️', '13': '🌨️', '14': '🌨️',
};

function getEmoji(icon: string): string {
  return weatherEmoji[icon.slice(0, 2)] || '🌤️';
}

function windDesc(speed: number): string {
  if (speed < 1) return '无风';
  if (speed < 6) return '微风';
  if (speed < 12) return '和风';
  if (speed < 20) return '强风';
  return '大风';
}

// 穿衣建议
function clothingAdvice(temp: number): string {
  if (temp >= 30) return '短袖短裤，注意防晒';
  if (temp >= 25) return '薄衬衫/T恤即可';
  if (temp >= 20) return '长袖或薄外套';
  if (temp >= 15) return '外套或薄夹克';
  if (temp >= 10) return '厚外套或风衣';
  if (temp >= 0) return '棉服/羽绒服';
  return '重度保暖，羽绒服+围巾手套';
}

export async function dailyWeather(ctx: TaskContext): Promise<void> {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) {
    ctx.logger.warn('OPENWEATHERMAP_API_KEY 未设置，跳过天气播报');
    return;
  }
  if (!ctx.sendMessageToOwner) {
    ctx.logger.warn('sendMessageToOwner 未注入，跳过天气播报');
    return;
  }

  const lat = process.env.WEATHER_LAT || DEFAULT_LAT;
  const lon = process.env.WEATHER_LON || DEFAULT_LON;
  const city = process.env.WEATHER_CITY || DEFAULT_CITY;

  try {
    // 并发请求当前天气 + 未来预报
    const [currentRes, forecastRes] = await Promise.all([
      fetch(`${API_BASE}/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=zh_cn`),
      fetch(`${API_BASE}/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=zh_cn&cnt=8`),
    ]);

    if (!currentRes.ok) {
      throw new Error(`天气API错误: ${currentRes.status} ${await currentRes.text()}`);
    }

    const current = await currentRes.json() as WeatherData;
    const forecast = forecastRes.ok ? await forecastRes.json() as ForecastData : null;

    // 格式化当前天气
    const w = current.weather[0];
    const emoji = getEmoji(w.icon);
    const temp = Math.round(current.main.temp);
    const feelsLike = Math.round(current.main.feels_like);
    const tempMin = Math.round(current.main.temp_min);
    const tempMax = Math.round(current.main.temp_max);

    let msg = `早上好！今日${city}天气播报 ${emoji}\n\n`;
    msg += `🌡️ 当前 ${temp}°C（体感 ${feelsLike}°C）\n`;
    msg += `📊 ${tempMin}°C ~ ${tempMax}°C｜${w.description}\n`;
    msg += `💧 湿度 ${current.main.humidity}%｜🌬️ ${windDesc(current.wind.speed)}\n`;

    // 未来趋势（取今天剩余时段）
    if (forecast?.list?.length) {
      msg += '\n📅 今日趋势：\n';
      const items = forecast.list.slice(0, 4); // 未来12小时，每3小时一个
      for (const item of items) {
        const time = new Date(item.dt * 1000);
        const h = String(time.getHours()).padStart(2, '0');
        const itemTemp = Math.round(item.main.temp);
        const pop = Math.round(item.pop * 100);
        const desc = item.weather[0].description;
        msg += `  ${h}:00  ${itemTemp}°C  ${desc}${pop > 20 ? `  🌧${pop}%` : ''}\n`;
      }
    }

    msg += `\n👔 穿衣建议：${clothingAdvice(temp)}`;

    // 降水提醒
    if (forecast?.list?.some(item => item.pop > 0.5)) {
      msg += '\n☂️ 今天有较大降水概率，记得带伞！';
    }

    await ctx.sendMessageToOwner(msg);
  } catch (error) {
    ctx.logger.error('天气播报失败', error);
    // 失败时发一条简短提示，不至于完全无声
    try {
      await ctx.sendMessageToOwner('⚠️ 今日天气获取失败，出门前看看窗外吧');
    } catch { /* ignore */ }
  }
}
