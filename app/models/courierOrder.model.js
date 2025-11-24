module.exports = (sequelize, Sequelize) => {
  const CourierOrder = sequelize.define(
    "courier_order",
    {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      courierChatId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      customerChatId: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      customerUserId: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      orderId: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      productName: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      liters: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
      },
      address: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      latitude: {
        type: Sequelize.DECIMAL(10, 7),
        allowNull: true,
      },
      longitude: {
        type: Sequelize.DECIMAL(10, 7),
        allowNull: true,
      },
      mapsUrl: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      phone: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      customerName: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      payload: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "pending",
      },
    },
    {
      timestamps: true,
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    }
  );

  return CourierOrder;
};

