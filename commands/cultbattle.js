const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pool = require('../database');

// ── Shared helpers (duplicated from cult.js since commands are separate files) ─
async function getCultByRole(guildId, roleId) {
  const { rows } = await pool.query(`SELECT * FROM cults WHERE guild_id = $1 AND role_id = $2`, [guildId, roleId]);
  return rows[0] || null;
}

async function getCultRoster(cult) {
  const { rows } = await pool.query(`SELECT * FROM cult_members WHERE cult_id = $1`, [cult.id]);
  return rows.map(m => ({ ...m, rank: m.user_id === cult.leader_id ? 'leader' : m.rank }));
}

async function syncMembers(guild, cult) {
  const role = guild.roles.cache.get(cult.role_id);
  if (!role) return;
  try { await guild.members.fetch({ force: false }); } catch {}
  for (const [memberId] of role.members) {
    await pool.query(`
      INSERT INTO cult_members (user_id, guild_id, cult_id, region)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, guild_id) DO NOTHING
    `, [memberId, guild.id, cult.id, hashRegion(memberId)]);
  }
}

function hashRegion(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return ['north', 'south', 'east', 'west'][hash % 4];
}

const RANK_POWER = { leader: 4, coleader: 3, general: 2, soldier: 1, recruit: 0 };
const STANCE_POWER_MULTIPLIER = { aggressive: 1.2, balanced: 1.0, defensive: 0.9 };
const STANCE_LABEL = { aggressive: '⚔️ Aggressive', balanced: '⚖️ Balanced', defensive: '🛡️ Defensive' };
const REGION_LABEL = { north: '⬆️ North', south: '⬇️ South', east: '➡️ East', west: '⬅️ West' };

function calcFighterPower(roster) {
  return roster.filter(m => m.is_alive).reduce((sum, m) => sum + (RANK_POWER[m.rank] || 0), 0);
}

function calcRoundPower(cult, fighterPower, stance) {
  const weaponBonus = 1 + (cult.weapon_level - 1) * 0.1;
  const stanceMult = STANCE_POWER_MULTIPLIER[stance] ?? 1.0;
  const base = fighterPower * 10 * weaponBonus * stanceMult;
  return Math.floor(base * (0.8 + Math.random() * 0.4));
}

const START_HEALTH = 100;

const ATTACK_LINES = [
  "{a} sends a wave of soldiers charging {b}'s gates, dealing {dmg} damage!",
  "{a} sets fire to {b}'s supply tents, dealing {dmg} damage!",
  "{a} ambushes {b}'s scouts in the night, dealing {dmg} damage!",
  "{a} breaches {b}'s defenses with a battering ram, dealing {dmg} damage!",
  "{a} rains arrows down on {b}'s ranks, dealing {dmg} damage!",
  "{a} poisons {b}'s well, dealing {dmg} damage!",
  "{a} unleashes their General on {b}'s frontline, dealing {dmg} damage!",
  "{a} sabotages {b}'s war drums, dealing {dmg} damage!",
];
const HEAL_LINES = [
  "{a} rallies their troops with a fiery speech, regaining {heal} health!",
  "{a}'s healers patch up the wounded, regaining {heal} health!",
  "{a} digs in and reinforces the walls, regaining {heal} health!",
  "{a} receives emergency supplies, regaining {heal} health!",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function healthBar(hp, max = START_HEALTH, length = 12) {
  const filled = Math.max(0, Math.min(length, Math.round((hp / max) * length)));
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

// ── Command ──────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('cultbattle')
    .setDescription('Start a cult vs cult battle — winning cult members get a reward role (Admin only)')
    .addRoleOption(opt => opt.setName('cult1').setDescription('First cult role').setRequired(true))
    .addRoleOption(opt => opt.setName('cult2').setDescription('Second cult role').setRequired(true))
    .addRoleOption(opt => opt.setName('reward').setDescription('Role given to every member of the winning cult').setRequired(true))
    .addStringOption(opt =>
      opt.setName('direction')
        .setDescription('Which region of cult2 to attack')
        .setRequired(true)
        .addChoices(
          { name: '⬆️ North', value: 'north' },
          { name: '⬇️ South', value: 'south' },
          { name: '➡️ East', value: 'east' },
          { name: '⬅️ West', value: 'west' },
        )
    ),

  async execute(interaction, client) {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ content: '⚠️ Only admins can start a cult battle.', flags: 64 });
    }

    const guild = interaction.guild;
    const cult1Role = interaction.options.getRole('cult1');
    const cult2Role = interaction.options.getRole('cult2');
    const rewardRole = interaction.options.getRole('reward');
    const direction = interaction.options.getString('direction');

    if (cult1Role.id === cult2Role.id) return interaction.reply({ content: '⚠️ Choose two different cults!', flags: 64 });

    const cult1 = await getCultByRole(guild.id, cult1Role.id);
    const cult2 = await getCultByRole(guild.id, cult2Role.id);
    if (!cult1) return interaction.reply({ content: `⚠️ <@&${cult1Role.id}> is not a registered cult!`, flags: 64 });
    if (!cult2) return interaction.reply({ content: `⚠️ <@&${cult2Role.id}> is not a registered cult!`, flags: 64 });

    await syncMembers(guild, cult1);
    await syncMembers(guild, cult2);

    const roster1 = await getCultRoster(cult1);
    const roster2 = await getCultRoster(cult2);

    const power1 = calcFighterPower(roster1);
    const power2Region = calcFighterPower(roster2.filter(m => m.region === direction));
    const power2Total = calcFighterPower(roster2);

    if (power1 === 0) return interaction.reply({ content: `⚠️ **${cult1.name}** has no fighters!`, flags: 64 });
    if (power2Total === 0) return interaction.reply({ content: `⚠️ **${cult2.name}** has no fighters!`, flags: 64 });

    // Stance picker for cult1 (the attacker)
    const stanceRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cb_aggressive_${interaction.id}`).setLabel('Aggressive').setEmoji('⚔️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cb_balanced_${interaction.id}`).setLabel('Balanced').setEmoji('⚖️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cb_defensive_${interaction.id}`).setLabel('Defensive').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
    );

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('⚔️ Cult Battle!')
        .setColor(0x6C63FF)
        .setDescription(
          `**${cult1.name}** <@&${cult1Role.id}> ⚔️ **${cult2.name}** <@&${cult2Role.id}>\n\n` +
          `🎯 Attack on **${REGION_LABEL[direction]}** region of **${cult2.name}**\n` +
          `🏆 Reward: <@&${rewardRole.id}> for each member of the winning cult\n\n` +
          `Choose the attack stance (30s, otherwise Balanced):`
        )],
      components: [stanceRow]
    });

    const promptMsg = await interaction.fetchReply();
    let stance1 = 'balanced';

    try {
      const click = await promptMsg.awaitMessageComponent({
        filter: i => i.customId.endsWith(`_${interaction.id}`) && i.user.id === interaction.user.id,
        time: 30000
      });
      stance1 = click.customId.split('_')[1];
      await click.update({
        embeds: [new EmbedBuilder().setColor(0x6C63FF).setDescription(`**${cult1.name}** chooses **${STANCE_LABEL[stance1]}** and marches on!`)],
        components: []
      });
    } catch {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x6C63FF).setDescription(`No stance chosen — **${cult1.name}** goes with **${STANCE_LABEL.balanced}**.`)],
        components: []
      });
    }

    const stance2 = cult2.war_stance || 'balanced';

    // ── HP-based turn battle ──
    // Each side's max HP scales with fighter power, so a bigger/stronger cult
    // can absorb more hits — member count and rank weighting both matter here.
    const maxHp1 = START_HEALTH + power1 * 5;
    const maxHp2 = START_HEALTH + power2Region * 5;
    let hp1 = maxHp1, hp2 = maxHp2;

    const MAX_TURNS = 6;
    let attackerIs1 = Math.random() < 0.5;
    const turnLog = [];

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (hp1 <= 0 || hp2 <= 0) break;

      const attackerName = attackerIs1 ? cult1.name : cult2.name;
      const defenderName = attackerIs1 ? cult2.name : cult1.name;
      const attackerCultObj = attackerIs1 ? cult1 : cult2;
      const attackerPower = attackerIs1 ? power1 : power2Region;
      const attackerStance = attackerIs1 ? stance1 : stance2;
      const isHeal = Math.random() < 0.2;

      if (isHeal) {
        const heal = 8 + Math.floor(Math.random() * 13); // 8-20
        if (attackerIs1) hp1 = Math.min(maxHp1, hp1 + heal); else hp2 = Math.min(maxHp2, hp2 + heal);
        turnLog.push(pick(HEAL_LINES).replace('{a}', `**${attackerName}**`).replace('{heal}', `**+${heal}**`));
      } else {
        const raw = calcRoundPower(attackerCultObj, attackerPower, attackerStance);
        const dmg = Math.max(5, Math.floor(raw / 8)); // scale the power roll down into a per-turn HP chunk
        if (attackerIs1) hp2 = Math.max(0, hp2 - dmg); else hp1 = Math.max(0, hp1 - dmg);
        turnLog.push(pick(ATTACK_LINES).replace('{a}', `**${attackerName}**`).replace('{b}', `**${defenderName}**`).replace('{dmg}', `**-${dmg}**`));
      }

      attackerIs1 = !attackerIs1;
    }

    const cult1Wins = hp1 === hp2 ? Math.random() < 0.5 : hp1 > hp2;
    const winnerCult = cult1Wins ? cult1 : cult2;
    const winnerRole = cult1Wins ? cult1Role : cult2Role;
    const winnerRoster = cult1Wins ? roster1 : roster2;
    const finalHp1 = Math.max(hp1, 0), finalHp2 = Math.max(hp2, 0);

    // Post the battle log
    await interaction.followUp({
      embeds: [new EmbedBuilder()
        .setTitle('⚔️ Cult Battle in Progress...')
        .setColor(0x6C63FF)
        .setDescription(turnLog.map(l => `• ${l}`).join('\n'))
        .addFields(
          { name: `${cult1.name}`, value: `${healthBar(finalHp1, maxHp1)} ${Math.round((finalHp1 / maxHp1) * 100)}%`, inline: true },
          { name: `${cult2.name}`, value: `${healthBar(finalHp2, maxHp2)} ${Math.round((finalHp2 / maxHp2) * 100)}%`, inline: true },
        )]
    });

    // Give reward role to every member of the winning cult
    await guild.members.fetch({ force: false });
    const rewarded = [];
    const failed = [];

    for (const member of winnerRoster) {
      try {
        const guildMember = guild.members.cache.get(member.user_id);
        if (guildMember) {
          await guildMember.roles.add(rewardRole.id);
          rewarded.push(member.user_id);
        }
      } catch {
        failed.push(member.user_id);
      }
    }

    const rewardedMentions = rewarded.map(id => `<@${id}>`).join(' ') || '*Nobody*';

    await interaction.followUp({
      embeds: [new EmbedBuilder()
        .setTitle(`🏆 ${winnerCult.name} wins the Cult Battle!`)
        .setColor(0xffd700)
        .setDescription(
          `<@&${cult1Role.id}> **vs** <@&${cult2Role.id}>\n` +
          `🎯 Attack: ${REGION_LABEL[direction]} from **${cult2.name}** (${STANCE_LABEL[stance2]})\n\n` +
          `**Final HP Standings:**\n` +
          `${cult1.name}: ${healthBar(finalHp1, maxHp1)} ${Math.round((finalHp1 / maxHp1) * 100)}%\n` +
          `${cult2.name}: ${healthBar(finalHp2, maxHp2)} ${Math.round((finalHp2 / maxHp2) * 100)}%`
        )
        .addFields(
          { name: `🏆 Winner`, value: `**${winnerCult.name}** <@&${winnerRole.id}>` },
          { name: `🎁 Rewarded Members (${rewarded.length})`, value: rewardedMentions.slice(0, 1000) },
          failed.length > 0 ? { name: '⚠️ Not Rewarded', value: `${failed.length} members could not receive the role (possibly left the server)` } : null,
        ).filter(Boolean)
        .setTimestamp()]
    });
  }
};