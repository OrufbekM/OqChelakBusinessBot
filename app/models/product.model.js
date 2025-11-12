module.exports = (sequelize, Sequelize) => {
  const Product = sequelize.define(
    "Product",
    {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      chatId: {
        type: Sequelize.BIGINT,
        allowNull: false,
        unique: false,
      },
      productName: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: false,
      },
      productPrice: {
        type: Sequelize.INTEGER,
        allowNull: true,
        unique: false,
      },
      productSize: {
        type: Sequelize.INTEGER,
        allowNull: true,
        unique: false,
      }
    },
    {
      timestamps: true,
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    }
  );

  return Product;
};