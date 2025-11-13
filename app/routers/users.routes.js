const express = require("express");
const router = express.Router();
const { getUsers, getUserById } = require("../controller/user.controller");

router.get("/", getUsers);
router.get("/:id", getUserById);

module.exports = router;
