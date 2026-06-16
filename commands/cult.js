const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pool = require('../database');

// ── DB Init ──────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cults (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      name TEXT NOT NULL,
      leader_id TEXT NOT NULL,
      gold INTEGER DEFAULT 0,
      max_members INTEGER DEFAULT 20,
      weapon_level INTEGER DEFAULT 1,
      bed_level INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(guild_id, role_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cult_members (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      cult_id INTEGER REFERENCES cults(id) ON DELETE CASCADE,
      rank TEXT DEFAULT 'recruit',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      is_alive BOOLEAN DEFAULT TRUE,
      PRIMARY KEY (user_id, guild_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_log (
      id SERIAL PRIMARY KEY,
      cult_id INTEGER REFERENCES cults(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wars (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      attacker_cult_id INTEGER REFERENCES cults(id),
      defender_cult_id INTEGER REFERENCES cults(id),
      attacker_score INTEGER DEFAULT 0,
      defender_score INTEGER DEFAULT 0,
      winner_cult_id INTEGER REFERENCES cults(id),
      gold_stolen INTEGER DEFAULT 0,
      prisoners TEXT[] DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      started_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

initDB().catch(err => console.error('❌ Cult DB init error:', err));

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getCultByRole(guildId, roleId) {
  const { rows } = await pool.query(
    `SELECT * FROM cults WHERE guild_id = $1 AND role_id = $2`,
    [guildId, roleId]
  );
  return rows[0] || null;
}

async function getCultById(id) {
  const { rows } = await pool.query(`SELECT * FROM cults WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getCultByLeader(guildId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM cults WHERE guild_id = $1 AND leader_id = $2`,
    [guildId, userId]
  );
  return rows[0] || null;
}

async function getMemberCult(guildId, userId) {
  const { rows } = await pool.query(
    `SELECT c.* FROM cults c
     JOIN cult_members cm ON cm.cult_id = c.id
     WHERE cm.user_id = $1 AND cm.guild_id = $2`,
    [userId, guildId]
  );
  return rows[0] || null;
}

async function syncMembers(guild, cult) {
  const role = guild.roles.cache.get(cult.role_id);
  if (!role) return;

  await guild.members.fetch();
  const members = role.members;

  for (const [memberId] of members) {
    await pool.query(`
      INSERT INTO cult_members (user_id, guild_id, cult_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, guild_id) DO NOTHING
    `, [memberId, guild.id, cult.id]);
  }
}

async function getMemberCount(cultId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FROM cult_members WHERE cult_id = $1`,
    [cultId]
  );
  return parseInt(rows[0].count);
}

function getRankEmoji(rank) {
  const emojis = { recruit: '⚔️', soldier: '🛡️', general: '⭐', leader: '👑' };
  return emojis[rank] || '⚔️';
}

const UPGRADE_COSTS = {
  expand: 500,
  weapons: 300,
  beds: 400,
};

function calcWarScore(cult, memberCount) {
  const weaponBonus = 1 + (cult.weapon_level - 1) * 0.1;
  const baseAttack = memberCount * 10;
  return Math.floor(baseAttack * weaponBonus);
}

function calcRespawnChance(bedLevel) {
  return Math.min(10 + (bedLevel - 1) * 10, 90); // 10% base, +10% per level, max 90%
}

// ── Command ──────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('cult')
    .setDescription('Cult management system')

    .addSubcommand(sub =>
      sub.setName('register')
        .setDescription('Register your cult role (staff/cult leader only)')
        .addRoleOption(opt => opt.setName('role').setDescription('Your cult role').setRequired(true))
        .addStringOption(opt => opt.setName('name').setDescription('Cult name').setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName('info')
        .setDescription('View cult info')
        .addRoleOption(opt => opt.setName('role').setDescription('Cult role (leave empty for your own cult)').setRequired(false))
    )

    .addSubcommand(sub =>
      sub.setName('members')
        .setDescription('View cult members')
        .addRoleOption(opt => opt.setName('role').setDescription('Cult role (leave empty for your own cult)').setRequired(false))
    )

    .addSubcommand(sub =>
      sub.setName('rank')
        .setDescription('Set a member\'s rank (cult leader only)')
        .addUserOption(opt => opt.setName('member').setDescription('Member to rank').setRequired(true))
        .addStringOption(opt =>
          opt.setName('rank')
            .setDescription('New rank')
            .setRequired(true)
            .addChoices(
              { name: '⚔️ Recruit', value: 'recruit' },
              { name: '🛡️ Soldier', value: 'soldier' },
              { name: '⭐ General', value: 'general' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('upgrade')
        .setDescription('Upgrade your cult (cult leader only)')
        .addStringOption(opt =>
          opt.setName('type')
            .setDescription('What to upgrade')
            .setRequired(true)
            .addChoices(
              { name: '👥 Expand (more members) — 500 gold', value: 'expand' },
              { name: '⚔️ Weapons (more attack power) — 300 gold', value: 'weapons' },
              { name: '🛏️ Beds (faster respawn) — 400 gold', value: 'beds' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('gold')
        .setDescription('View your cult\'s gold')
    )

    .addSubcommand(sub =>
      sub.setName('addgold')
        .setDescription('Add gold to a cult (staff only)')
        .addRoleOption(opt => opt.setName('role').setDescription('Cult role').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of gold').setRequired(true).setMinValue(1))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason').setRequired(false))
    )

    .addSubcommand(sub =>
      sub.setName('war')
        .setDescription('Declare war on another cult (cult leader only)')
        .addRoleOption(opt => opt.setName('enemy').setDescription('Enemy cult role').setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('View all cults in this server')
    ),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    await guild.members.fetch();

    // ── REGISTER ──────────────────────────────────────────────────────────────
    if (sub === 'register') {
      const role = interaction.options.getRole('role');
      const name = interaction.options.getString('name');

      const existing = await getCultByRole(guild.id, role.id);
      if (existing) return interaction.reply({ content: `⚠️ <@&${role.id}> is already registered as a cult!`, flags: 64 });

      await pool.query(
        `INSERT INTO cults (guild_id, role_id, name, leader_id) VALUES ($1, $2, $3, $4)`,
        [guild.id, role.id, name, interaction.user.id]
      );

      const cult = await getCultByRole(guild.id, role.id);
      await syncMembers(guild, cult);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('⚔️ Cult Registered!')
          .setColor(role.color || 0x6C63FF)
          .setDescription(`**${name}** has been registered!\nRole: <@&${role.id}>\nLeader: <@${interaction.user.id}>`)
          .addFields(
            { name: '👥 Max Members', value: '20', inline: true },
            { name: '💰 Gold', value: '0', inline: true },
            { name: '⚔️ Weapon Level', value: '1', inline: true },
          )]
      });
    }

    // ── INFO ──────────────────────────────────────────────────────────────────
    if (sub === 'info') {
      const role = interaction.options.getRole('role');
      let cult;

      if (role) {
        cult = await getCultByRole(guild.id, role.id);
      } else {
        cult = await getMemberCult(guild.id, interaction.user.id);
        if (!cult) cult = await getCultByLeader(guild.id, interaction.user.id);
      }

      if (!cult) return interaction.reply({ content: '⚠️ Cult not found! Join a cult or specify a role.', flags: 64 });

      await syncMembers(guild, cult);
      const memberCount = await getMemberCount(cult.id);
      const discordRole = guild.roles.cache.get(cult.role_id);
      const respawnChance = calcRespawnChance(cult.bed_level);
      const weaponBonus = Math.floor((cult.weapon_level - 1) * 10);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`⚔️ ${cult.name}`)
          .setColor(discordRole?.color || 0x6C63FF)
          .addFields(
            { name: '👑 Leader', value: `<@${cult.leader_id}>`, inline: true },
            { name: '🎭 Role', value: `<@&${cult.role_id}>`, inline: true },
            { name: '💰 Gold', value: `${cult.gold}`, inline: true },
            { name: '👥 Members', value: `${memberCount}/${cult.max_members}`, inline: true },
            { name: '⚔️ Weapon Level', value: `${cult.weapon_level} (+${weaponBonus}% attack)`, inline: true },
            { name: '🛏️ Bed Level', value: `${cult.bed_level} (${respawnChance}% respawn)`, inline: true },
          )
          .setTimestamp()]
      });
    }

    // ── MEMBERS ───────────────────────────────────────────────────────────────
    if (sub === 'members') {
      const role = interaction.options.getRole('role');
      let cult;

      if (role) {
        cult = await getCultByRole(guild.id, role.id);
      } else {
        cult = await getMemberCult(guild.id, interaction.user.id);
        if (!cult) cult = await getCultByLeader(guild.id, interaction.user.id);
      }

      if (!cult) return interaction.reply({ content: '⚠️ Cult not found!', flags: 64 });

      await syncMembers(guild, cult);

      const { rows: members } = await pool.query(
        `SELECT * FROM cult_members WHERE cult_id = $1 ORDER BY
          CASE rank WHEN 'leader' THEN 1 WHEN 'general' THEN 2 WHEN 'soldier' THEN 3 ELSE 4 END`,
        [cult.id]
      );

      const lines = members.map(m =>
        `${getRankEmoji(m.rank)} <@${m.user_id}> — **${m.rank}** ${m.is_alive ? '' : '💀'}`
      ).join('\n') || '*No members yet*';

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`👥 ${cult.name} — Members (${members.length}/${cult.max_members})`)
          .setColor(guild.roles.cache.get(cult.role_id)?.color || 0x6C63FF)
          .setDescription(lines)]
      });
    }

    // ── RANK ──────────────────────────────────────────────────────────────────
    if (sub === 'rank') {
      const cult = await getCultByLeader(guild.id, interaction.user.id);
      if (!cult) return interaction.reply({ content: '⚠️ You are not a cult leader!', flags: 64 });

      const target = interaction.options.getUser('member');
      const newRank = interaction.options.getString('rank');

      const { rows } = await pool.query(
        `SELECT * FROM cult_members WHERE user_id = $1 AND cult_id = $2`,
        [target.id, cult.id]
      );
      if (rows.length === 0) return interaction.reply({ content: `⚠️ <@${target.id}> is not in your cult!`, flags: 64 });

      await pool.query(
        `UPDATE cult_members SET rank = $1 WHERE user_id = $2 AND cult_id = $3`,
        [newRank, target.id, cult.id]
      );

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('⭐ Rank Updated!')
          .setColor(0xffd700)
          .setDescription(`<@${target.id}> is now a **${newRank}** ${getRankEmoji(newRank)} in **${cult.name}**!`)]
      });
    }

    // ── UPGRADE ───────────────────────────────────────────────────────────────
    if (sub === 'upgrade') {
      const cult = await getCultByLeader(guild.id, interaction.user.id);
      if (!cult) return interaction.reply({ content: '⚠️ You are not a cult leader!', flags: 64 });

      const type = interaction.options.getString('type');
      const cost = UPGRADE_COSTS[type];

      if (cult.gold < cost) {
        return interaction.reply({ content: `❌ Not enough gold! You need **${cost}** gold but have **${cult.gold}**.`, flags: 64 });
      }

      let updateField, newValue, description;

      if (type === 'expand') {
        newValue = cult.max_members + 10;
        updateField = 'max_members';
        description = `Max members increased to **${newValue}**!`;
      } else if (type === 'weapons') {
        newValue = cult.weapon_level + 1;
        updateField = 'weapon_level';
        description = `Weapon level is now **${newValue}** (+${(newValue - 1) * 10}% attack power)!`;
      } else if (type === 'beds') {
        newValue = cult.bed_level + 1;
        updateField = 'bed_level';
        description = `Bed level is now **${newValue}** (${calcRespawnChance(newValue)}% respawn chance)!`;
      }

      await pool.query(
        `UPDATE cults SET ${updateField} = $1, gold = gold - $2 WHERE id = $3`,
        [newValue, cost, cult.id]
      );

      await pool.query(
        `INSERT INTO gold_log (cult_id, amount, reason) VALUES ($1, $2, $3)`,
        [cult.id, -cost, `Upgrade: ${type}`]
      );

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('⬆️ Upgrade Complete!')
          .setColor(0x00ff00)
          .setDescription(`**${cult.name}** upgraded!\n\n${description}\n\n💰 Remaining gold: **${cult.gold - cost}**`)]
      });
    }

    // ── GOLD ──────────────────────────────────────────────────────────────────
    if (sub === 'gold') {
      let cult = await getMemberCult(guild.id, interaction.user.id);
      if (!cult) cult = await getCultByLeader(guild.id, interaction.user.id);
      if (!cult) return interaction.reply({ content: '⚠️ You are not in a cult!', flags: 64 });

      const { rows: log } = await pool.query(
        `SELECT * FROM gold_log WHERE cult_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [cult.id]
      );

      const logLines = log.map(l =>
        `${l.amount > 0 ? '➕' : '➖'} **${Math.abs(l.amount)}** gold — ${l.reason}`
      ).join('\n') || '*No transactions yet*';

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`💰 ${cult.name} — Treasury`)
          .setColor(0xffd700)
          .addFields(
            { name: 'Current Gold', value: `**${cult.gold}** 💰` },
            { name: 'Upgrade Costs', value: `👥 Expand: 500g\n⚔️ Weapons: 300g\n🛏️ Beds: 400g` },
            { name: 'Recent Transactions', value: logLines }
          )]
      });
    }

    // ── ADD GOLD ──────────────────────────────────────────────────────────────
    if (sub === 'addgold') {
      const role = interaction.options.getRole('role');
      const amount = interaction.options.getInteger('amount');
      const reason = interaction.options.getString('reason') || 'Staff grant';

      const cult = await getCultByRole(guild.id, role.id);
      if (!cult) return interaction.reply({ content: '⚠️ That role is not a registered cult!', flags: 64 });

      await pool.query(`UPDATE cults SET gold = gold + $1 WHERE id = $2`, [amount, cult.id]);
      await pool.query(`INSERT INTO gold_log (cult_id, amount, reason) VALUES ($1, $2, $3)`, [cult.id, amount, reason]);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('💰 Gold Added!')
          .setColor(0xffd700)
          .setDescription(`**+${amount}** gold added to **${cult.name}**!\nReason: ${reason}\nNew total: **${cult.gold + amount}** 💰`)]
      });
    }

    // ── WAR ───────────────────────────────────────────────────────────────────
    if (sub === 'war') {
      const attackerCult = await getCultByLeader(guild.id, interaction.user.id);
      if (!attackerCult) return interaction.reply({ content: '⚠️ You are not a cult leader!', flags: 64 });

      const enemyRole = interaction.options.getRole('enemy');
      const defenderCult = await getCultByRole(guild.id, enemyRole.id);
      if (!defenderCult) return interaction.reply({ content: '⚠️ That role is not a registered cult!', flags: 64 });
      if (defenderCult.id === attackerCult.id) return interaction.reply({ content: '⚠️ You cannot declare war on yourself!', flags: 64 });

      // Check no active war between these cults
      const { rows: activeWar } = await pool.query(`
        SELECT * FROM wars WHERE guild_id = $1 AND status = 'active'
        AND (attacker_cult_id = $2 OR defender_cult_id = $2)
      `, [guild.id, attackerCult.id]);
      if (activeWar.length > 0) return interaction.reply({ content: '⚠️ Your cult is already in a war!', flags: 64 });

      await syncMembers(guild, attackerCult);
      await syncMembers(guild, defenderCult);

      const attackerCount = await getMemberCount(attackerCult.id);
      const defenderCount = await getMemberCount(defenderCult.id);

      const attackerScore = calcWarScore(attackerCult, attackerCount);
      const defenderScore = calcWarScore(defenderCult, defenderCount);

      // Add randomness (±20%)
      const atkFinal = Math.floor(attackerScore * (0.8 + Math.random() * 0.4));
      const defFinal = Math.floor(defenderScore * (0.8 + Math.random() * 0.4));

      const attackerWins = atkFinal > defFinal;
      const winnerCult = attackerWins ? attackerCult : defenderCult;
      const loserCult = attackerWins ? defenderCult : attackerCult;

      // Gold stolen (10-30% of loser's gold)
      const goldStolen = Math.floor(loserCult.gold * (0.1 + Math.random() * 0.2));

      // Capture chance — random members from loser
      const { rows: loserMembers } = await pool.query(
        `SELECT user_id FROM cult_members WHERE cult_id = $1 AND is_alive = TRUE`,
        [loserCult.id]
      );
      const captureCount = Math.floor(loserMembers.length * 0.1) + 1; // capture ~10%
      const prisoners = loserMembers
        .sort(() => Math.random() - 0.5)
        .slice(0, Math.min(captureCount, loserMembers.length))
        .map(m => m.user_id);

      // Respawn chance for losers
      const respawnChance = calcRespawnChance(loserCult.bed_level);
      const deadMembers = [];
      for (const member of loserMembers) {
        if (prisoners.includes(member.user_id)) continue;
        const survives = Math.random() * 100 < respawnChance;
        if (!survives) {
          deadMembers.push(member.user_id);
          await pool.query(
            `UPDATE cult_members SET is_alive = FALSE WHERE user_id = $1 AND cult_id = $2`,
            [member.user_id, loserCult.id]
          );
        }
      }

      // Transfer gold
      await pool.query(`UPDATE cults SET gold = gold - $1 WHERE id = $2`, [goldStolen, loserCult.id]);
      await pool.query(`UPDATE cults SET gold = gold + $1 WHERE id = $2`, [goldStolen, winnerCult.id]);
      await pool.query(`INSERT INTO gold_log (cult_id, amount, reason) VALUES ($1, $2, $3)`, [winnerCult.id, goldStolen, `War victory vs ${loserCult.name}`]);
      await pool.query(`INSERT INTO gold_log (cult_id, amount, reason) VALUES ($1, $2, $3)`, [loserCult.id, -goldStolen, `War defeat vs ${winnerCult.name}`]);

      // Log war
      await pool.query(`
        INSERT INTO wars (guild_id, attacker_cult_id, defender_cult_id, attacker_score, defender_score, winner_cult_id, gold_stolen, prisoners, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finished')
      `, [guild.id, attackerCult.id, defenderCult.id, atkFinal, defFinal, winnerCult.id, goldStolen, prisoners]);

      const attackerRole = guild.roles.cache.get(attackerCult.role_id);
      const defenderRole = guild.roles.cache.get(defenderCult.role_id);

      const prisonerMentions = prisoners.map(id => `<@${id}>`).join(', ') || 'None';
      const deadMentions = deadMembers.map(id => `<@${id}>`).join(', ') || 'None';

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('⚔️ WAR RESULTS')
          .setColor(attackerWins ? 0x00ff00 : 0xff0000)
          .setDescription(`<@&${attackerRole?.id}> **vs** <@&${defenderRole?.id}>`)
          .addFields(
            { name: `${attackerCult.name} Power`, value: `${atkFinal}`, inline: true },
            { name: `${defenderCult.name} Power`, value: `${defFinal}`, inline: true },
            { name: '🏆 Winner', value: `**${winnerCult.name}**` },
            { name: '💰 Gold Stolen', value: `${goldStolen} gold from ${loserCult.name}`, inline: true },
            { name: '🔒 Prisoners', value: prisonerMentions, inline: true },
            { name: '💀 Casualties', value: deadMentions.slice(0, 200) },
          )
          .setTimestamp()]
      });
    }

    // ── LIST ──────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      await interaction.deferReply();
      const { rows: cults } = await pool.query(
        `SELECT c.*, (SELECT COUNT(*) FROM cult_members WHERE cult_id = c.id) as member_count
         FROM cults c WHERE c.guild_id = $1 ORDER BY c.gold DESC`,
        [guild.id]
      );

      if (cults.length === 0) return interaction.editReply({ content: '📭 No cults registered yet!' });

      const lines = cults.map((c, i) =>
        `**${i + 1}.** <@&${c.role_id}> — **${c.name}**\n👥 ${c.member_count}/${c.max_members} | 💰 ${c.gold}g | ⚔️ Weapons Lv${c.weapon_level} | 🛏️ Beds Lv${c.bed_level}`
      ).join('\n\n');

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('⚔️ All Cults')
          .setColor(0x6C63FF)
          .setDescription(lines)
          .setTimestamp()]
      });
    }
  }
};