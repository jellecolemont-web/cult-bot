const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const pool = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your personal gold balance'),

  async execute(interaction, client) {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    const { rows } = await pool.query(
      `SELECT balance FROM wallets WHERE user_id = $1 AND guild_id = $2`,
      [userId, guildId]
    );
    const balance = rows[0]?.balance || 0;

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 ${interaction.user.username}'s Wallet`)
        .setColor(0xffd700)
        .setDescription(`Balance: **${balance}** gold`)],
      flags: 64
    });
  }
};