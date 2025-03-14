import Redis from "../utils/redis";

class RedisLogger extends Redis {
  private static ttlLOG: number = 86400;
  private static ttlBAN: number = 86400 * 7;

  private static instance: RedisLogger; 
  private static isConfigured: boolean = false;

  static config(ttlLOG?: number, ttlBAN?: number) { // Config use only in IPLogger
    if (this.isConfigured) { // if this will be use in other class - return error
      RedisLogger.getInstance().pino.log({
        level: LogLevel.ERROR,
        method: "RedisLogger",
        message: "is already configured"
      });
      return;
    }

    if (ttlLOG) RedisLogger.ttlLOG = ttlLOG;
    if (ttlBAN) RedisLogger.ttlBAN = ttlBAN;

    this.isConfigured = true;
  }

  static getInstance(): RedisLogger { // Instance of redis logger
    if (!RedisLogger.instance) {
      RedisLogger.instance = new RedisLogger();
    }
    return RedisLogger.instance;
  }

  constructor() {
    super();
    RedisLogger.ttlLOG = RedisLogger.ttlLOG;
    RedisLogger.ttlBAN = RedisLogger.ttlBAN;
  }

  async logVisit(ip: string, userAgent: string, url: string): Promise<void> {
    try {
      const lastVisit = Date.now();
      const multi = this.client.multi();

      // create ip
      multi.hSet(`ip:${ip}`, { userAgent, lastVisit });
      multi.expire(`ip:${ip}`, RedisLogger.ttlLOG);

      multi.sAdd(`urls:${ip}`, url);
      multi.expire(`urls:${ip}`, RedisLogger.ttlLOG);

      // this need for sort in LogData
      multi.zAdd("ips_by_time", { score: lastVisit, value: ip }); // sort by visits
      multi.zIncrBy("active_ips", 1, ip); // sort by activity

      // if this is new client userAgent or new ip - create
      multi.sAdd("UserAgents", userAgent);
      multi.expire("UserAgents", RedisLogger.ttlLOG);
      
      multi.sAdd(`UserAgent:${userAgent}`, ip);
      multi.expire(`UserAgent:${userAgent}`, RedisLogger.ttlLOG);

      // this need for sort in LogData
      multi.zAdd("uas_by_time", { score: lastVisit, value: userAgent }); // sort by visits
      multi.zIncrBy("active_uas", 1, userAgent); // sort by activity

      const result = await multi.exec(); 

      if (!result) {
        this.pino.log({
          level: LogLevel.ERROR,
          method: "logVisit",
          message: "Failed to execute Redis transaction"
        });
      };
    } catch (error: unknown) {
      this.pino.log({
        level: LogLevel.ERROR,
        method: "logVisit",
        error: error
      });
    }
  }

  // ban logic
  async banIP(ip: string): Promise<void> {
    try {
      // this method is available only in client. so here there aren`t check for ban
      if (!ip?.trim()) {
        this.pino.log({
          level: LogLevel.WARN,
          method: "banIP",
          message: "IP is missing"
        });
        return;
      }

      const multi = this.client.multi();

      // delete data
      multi.del(`ip:${ip}`);
      multi.del(`urls:${ip}`);

      // delete from sort
      multi.zRem("ips_by_time", ip);
      multi.zRem("active_ips", ip);

      // add to banned list
      const expireAt = Date.now() + RedisLogger.ttlBAN * 1000;
      multi.zAdd("banned_ips", { score: expireAt, value: ip });

      const result = await multi.exec(); 

      if (!result) {
        this.pino.log({
          level: LogLevel.ERROR,
          method: "banIP",
          message: "Failed to execute Redis transaction"
        });
      };
    } catch (error: unknown) {
      this.pino.log({
        level: LogLevel.ERROR,
        method: "banIP",
        error: error
      });
    }
  }


  async banUA(ua: string): Promise<void> {
    try {
      // this method is available only in client. so here there aren`t check for ban
      if (!ua) {
        this.pino.log({
          level: LogLevel.WARN,
          method: "banUA",
          message: "UA is missing"
        });
        return;
      }

      // get all ips and ban them
      const ipList = await this.client.sMembers(`UserAgent:${ua}`);

      if (ipList.length > 0) {
        await Promise.all(ipList.map((ip: string) => this.banIP(ip)));
      }

      // throw ua into banned uas
      const multi = this.client.multi();

      // delete from sort
      multi.zRem("uas_by_time", ua);
      multi.zRem("active_uas", ua);

      // add to banned list
      const expireAt = Date.now() + RedisLogger.ttlBAN * 1000;
      multi.zAdd("banned_uas", { score: expireAt, value: ua });

      const result = await multi.exec(); 

      if (!result) {
        this.pino.log({
          level: LogLevel.ERROR,
          method: "banUA",
          message: "Failed to execute Redis transaction"
        });
      };
    } catch (error: unknown) {
      this.pino.log({
        level: LogLevel.ERROR,
        method: "banUA",
        error: error
      });
    }
  }

  // unban logic
  async unbanIP(ip: string): Promise<void> {
    try {
      // this method is available only in client. so here there aren`t check for ban
      if (!ip?.trim()) {
        this.pino.log({
          level: LogLevel.WARN,
          method: "unbanIP",
          message: "IP is missing"
        });
        return;
      }

      await this.client.zRem("banned_ips", ip);
    } catch (error: unknown) {
      this.pino.log({
        level: LogLevel.ERROR,
        method: "unbanIP",
        error: error
      });
    }
  }

  async unbanUA(ua: string): Promise<void> {
    try {
      // this method is available only in client. so here there aren`t check for ban
      if (!ua) {
        this.pino.log({
          level: LogLevel.WARN,
          method: "unbanUA",
          message: "UA is missing"
        });
        return;
      }

      // get all ips, that they can visit site
      const ipList = await this.client.sMembers(`UserAgent:${ua}`);
      if (ipList.length > 0) {
        await Promise.all(ipList.map(ip => this.unbanIP(ip)));
      }

      // get this from banned uas
      await this.client.zRem("banned_uas", ua);
    } catch (error: unknown) {
      this.pino.log({
        level: LogLevel.ERROR,
        method: "unbanUA",
        error: error
      });
    }
  }

  // check by ban
  async isBannedByIP(ip: string): Promise<boolean> {
    try {
      if (!ip?.trim()) {
        this.pino.log({
          level: LogLevel.WARN,
          method: "isBannedByIP",
          message: "IP is missing"
        });
        return false;
      }

      const now = Date.now();

      await this.client.zRemRangeByScore("banned_ips", 0, now);

      const score = await this.client.zScore("banned_ips", ip);
        
      return score !== null && score > now;
    } catch (error: unknown) {
      this.pino.log({
        level: LogLevel.ERROR,
        method: "isBannedByIP",
        error: error
      });
      return false;
    }
  }

  async isBannedByUA(ua: string): Promise<boolean> {
    try {
      if (!ua) {
        this.pino.log({
          level: LogLevel.WARN,
          method: "isBannedByUA",
          message: "UA is missing"
        });
        return false;
      }

      const now = Date.now();

      await this.client.zRemRangeByScore("banned_uas", 0, now);

      const score = await this.client.zScore("banned_uas", ua);
        
      return score !== null && score > now;
    } catch (error: unknown) {
      this.pino.log({
        level: LogLevel.ERROR,
        method: "isBannedByUA",
        error: error
      });
      return false;
    }
  }
}

export default RedisLogger;
