module.exports = (sequelize, Sequelize) => {
  const User = sequelize.define(
    "user",
    {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      chatId: {
        type: Sequelize.BIGINT,
        allowNull: false,
        unique: true,
      },
      username: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: false,
      },
      email: {
        type: Sequelize.STRING,
        allowNull: true,
        validate: { isEmail: true },
      },
      password: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      firstName: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      lastName: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      avatar: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      bio: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      phone: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      isOnline: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      },
      lastSeen: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
      },
      showOnlineStatus: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
      },
      allowedLocations: {
        type: Sequelize.JSON,
        defaultValue: ["all"],
      },
      currentSessionId: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      currentLocation: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      onlineVisibility: {
        type: Sequelize.ENUM("everyone", "contacts", "nobody", "custom"),
        defaultValue: "everyone",
      },
      hiddenFromUsers: {
        type: Sequelize.JSON,
        defaultValue: [],
      },
      latitude: {
        type: Sequelize.DECIMAL(10, 7),
        allowNull: true,
      },
      longitude: {
        type: Sequelize.DECIMAL(10, 7),
        allowNull: true,
      },
    },
    {
      timestamps: true,
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    }
  );

  return User;
};


