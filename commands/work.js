const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const pool = require('../database');

const WORK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour — tune as needed
const WORK_MIN = 50;
const WORK_MAX = 200;

// Wallets table is also created by cult.js's initDB, but this CREATE TABLE
// IF NOT EXISTS is duplicated here so /work works even if cult.js hasn't
// finished its own init yet (or is ever removed).
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      balance INTEGER DEFAULT 0,
      last_work TIMESTAMPTZ,
      PRIMARY KEY (user_id, guild_id)
    )
  `);
}
initDB().catch(err => console.error('❌ Wallet DB init error:', err));

function formatDuration(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('work')
    .setDescription('Work to earn personal gold'),

  async execute(interaction, client) {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    const { rows } = await pool.query(
      `SELECT * FROM wallets WHERE user_id = $1 AND guild_id = $2`,
      [userId, guildId]
    );
    const wallet = rows[0];

    if (wallet?.last_work) {
      const elapsed = Date.now() - new Date(wallet.last_work).getTime();
      if (elapsed < WORK_COOLDOWN_MS) {
        const remaining = WORK_COOLDOWN_MS - elapsed;
        return interaction.reply({
          content: `⏳ You're tired from work! Try again in **${formatDuration(remaining)}**.`,
          flags: 64
        });
      }
    }

    const earned = Math.floor(Math.random() * (WORK_MAX - WORK_MIN + 1)) + WORK_MIN;

    await pool.query(`
      INSERT INTO wallets (user_id, guild_id, balance, last_work)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, guild_id)
      DO UPDATE SET balance = wallets.balance + $3, last_work = NOW()
    `, [userId, guildId, earned]);

    const newBalance = (wallet?.balance || 0) + earned;

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('💼 You went to work!')
        .setColor(0x00ff00)
        .setDescription(`You earned **${earned}** gold!\n💰 Balance: **${newBalance}**\n\n⚠️ Remember: your cult collects daily tax from this balance.`)]
    });
  }
};