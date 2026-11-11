export const LAISHAN={name:'烟台 · 莱山',latitude:37.47,longitude:121.45,timezone:'Asia/Shanghai'};
export function weatherLocation(latitude,longitude) {
  if(latitude==null&&longitude==null)return LAISHAN;
  if(latitude==null||longitude==null||String(latitude).trim()===''||String(longitude).trim()==='')throw new Error('定位坐标无效');
  const lat=Number(latitude),lon=Number(longitude);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw new Error('定位坐标无效');
  // Weather needs a neighbourhood, not an exact address. Coordinates stay in memory.
  return {name:'当前位置',latitude:Math.round(lat*100)/100,longitude:Math.round(lon*100)/100,timezone:'auto'};
}
export class WeatherForecast {
  constructor({fetcher=fetch,now=Date.now}={}){this.fetch=fetcher;this.now=now;this.cache=new Map();this.pending=new Map();}
  async read(location=LAISHAN){
    const point=location===LAISHAN?LAISHAN:weatherLocation(location.latitude,location.longitude);
    const key=`${point.name}:${point.latitude},${point.longitude}`,cached=this.cache.get(key);
    if(cached&&this.now()-cached.fetchedAt<900000)return {...cached,stale:false};
    if(this.pending.has(key))return this.pending.get(key);
    const work=(async()=>{try{
      const url=new URL('https://api.open-meteo.com/v1/forecast');url.search=new URLSearchParams({latitude:String(point.latitude),longitude:String(point.longitude),timezone:point.timezone,current:'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',forecast_days:'5',wind_speed_unit:'kmh'});
      const response=await this.fetch(url,{signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error('天气服务暂时不可用');const data=await response.json();
      if(!Number.isFinite(data.current?.temperature_2m)||!Array.isArray(data.daily?.time))throw new Error('天气数据不完整');
      const value={city:point.name,location:point===LAISHAN?'default':'device',timezone:data.timezone||'Asia/Shanghai',fetchedAt:this.now(),current:{time:data.current.time,temperature:data.current.temperature_2m,feelsLike:data.current.apparent_temperature,humidity:data.current.relative_humidity_2m,code:data.current.weather_code,wind:data.current.wind_speed_10m,isDay:data.current.is_day},days:data.daily.time.slice(0,5).map((date,i)=>({date,code:data.daily.weather_code?.[i],high:data.daily.temperature_2m_max?.[i],low:data.daily.temperature_2m_min?.[i],rain:data.daily.precipitation_probability_max?.[i]})),source:'Open-Meteo'};
      this.cache.set(key,value);if(this.cache.size>16)this.cache.delete(this.cache.keys().next().value);return {...value,stale:false};
    }catch(error){if(cached&&this.now()-cached.fetchedAt<7200000)return {...cached,stale:true};throw new Error(`${point.name}天气暂时无法更新，请稍后重试。`);}finally{this.pending.delete(key);}})();this.pending.set(key,work);return work;
  }
}
