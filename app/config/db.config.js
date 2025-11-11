require("dotenv").config();

module.exports = {
    HOST: process.env.DB_HOST || "localhost",
    USER: process.env.DB_USER || "postgres",
    PASSWORD: process.env.DB_PASSWORD || "",
    DB: process.env.DB_NAME || "oqchelackbusiness",
    dialect: process.env.DB_DIALECT || "postgres",
    pool: {
      max: parseInt(process.env.DB_POOL_MAX || "5", 10),
      min: parseInt(process.env.DB_POOL_MIN || "0", 10),
      acquire: parseInt(process.env.DB_POOL_ACQUIRE_MS || "30000", 10),
      idle: parseInt(process.env.DB_POOL_IDLE_MS || "10000", 10),
    },
  };
  
  