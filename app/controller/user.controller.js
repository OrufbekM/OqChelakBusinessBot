const db = require("../models");

async function getUsers(req, res) {
  try {
    const users = await db.User.findAll();
    res.json({ ok: true, users });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function getUserById(req, res) {
  try {
    const id = req.params.id;
    const user = await db.User.findByPk(id);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

module.exports = { getUsers, getUserById };
