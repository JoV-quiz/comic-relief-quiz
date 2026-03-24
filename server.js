const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Bypass localtunnel splash page + prevent caching during dev
app.use((req, res, next) => {
  res.setHeader('Bypass-Tunnel-Reminder', 'true');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static('public'));

// Game state
const state = {
  players: new Map(),       // socketId -> { name, score, answered, team, mode }
  teams: new Map(),         // teamName -> { score, members[] }
  questions: [],
  currentIndex: -1,
  phase: 'lobby',           // lobby | question | reveal | finished
  questionStartTime: null,
  questionDuration: 30000,  // 30 seconds per question
  questionTimer: null,
};

function getLeaderboard() {
  // Build individual scores
  const individuals = Array.from(state.players.values())
    .filter(p => p.mode === 'individual')
    .map(p => ({ name: p.name, score: p.score, type: 'individual' }));

  // Build team scores (sum of member scores)
  const teamScores = [];
  for (const [teamName, team] of state.teams) {
    const totalScore = team.members.reduce((sum, socketId) => {
      const p = state.players.get(socketId);
      return sum + (p ? p.score : 0);
    }, 0);
    teamScores.push({ name: `🏠 ${teamName}`, score: totalScore, type: 'team' });
  }

  return [...individuals, ...teamScores].sort((a, b) => b.score - a.score);
}

function autoReveal() {
  if (state.currentIndex < 0 || state.currentIndex >= state.questions.length) return;
  if (state.phase !== 'question') return;
  state.phase = 'reveal';
  const q = state.questions[state.currentIndex];
  io.emit('answerRevealed', {
    correctIndex: q.correctIndex,
    leaderboard: getLeaderboard().slice(0, 10),
  });
  io.emit('timerExpired');
}

function getPlayerCount() {
  return state.players.size;
}

function broadcastPlayerCount() {
  io.emit('playerCount', getPlayerCount());
  io.emit('liveScores', getAllPlayerScores());
}

function getAllPlayerScores() {
  return Array.from(state.players.values())
    .map(p => ({ name: p.name, score: p.score, team: p.team, mode: p.mode, avatar: p.avatar }))
    .sort((a, b) => b.score - a.score);
}

function getCurrentQuestion() {
  if (state.currentIndex < 0 || state.currentIndex >= state.questions.length) return null;
  const q = state.questions[state.currentIndex];
  return {
    index: state.currentIndex,
    total: state.questions.length,
    text: q.text,
    options: q.options,
  };
}

io.on('connection', (socket) => {
  // Player joins
  socket.on('joinGame', (data) => {
    const name = ((data && data.name) || '').trim().substring(0, 30);
    const mode = (data && data.mode) || 'individual';
    const teamName = ((data && data.team) || '').trim().substring(0, 30);

    if (!name) return socket.emit('appError', 'Name is required');
    if (mode === 'team' && !teamName) return socket.emit('appError', 'Team name is required');

    const player = { name, score: 0, answered: false, mode, team: teamName || null, avatar: (data && data.avatar) || '' };
    state.players.set(socket.id, player);

    // Register team
    if (mode === 'team') {
      if (!state.teams.has(teamName)) {
        state.teams.set(teamName, { score: 0, members: [] });
      }
      state.teams.get(teamName).members.push(socket.id);
    }

    socket.emit('joined', { name, phase: state.phase, mode, team: teamName });
    broadcastPlayerCount();

    // If a question is active, send it to the late joiner
    if (state.phase === 'question') {
      socket.emit('newQuestion', getCurrentQuestion());
    }
  });

  // Quizmaster loads questions
  socket.on('loadQuestions', (questions) => {
    if (!Array.isArray(questions) || questions.length === 0) {
      return socket.emit('appError', 'Invalid questions');
    }
    state.questions = questions;
    state.currentIndex = -1;
    state.phase = 'lobby';
    socket.emit('questionsLoaded', { count: questions.length });
  });

  // Quizmaster advances to next question
  socket.on('nextQuestion', () => {
    // Clear any existing timer
    if (state.questionTimer) {
      clearTimeout(state.questionTimer);
      state.questionTimer = null;
    }

    state.currentIndex++;
    if (state.currentIndex >= state.questions.length) {
      state.phase = 'finished';
      io.emit('quizFinished', { leaderboard: getLeaderboard() });
      return;
    }

    state.phase = 'question';
    state.questionStartTime = Date.now();

    // Reset answered flag for all players
    for (const p of state.players.values()) {
      p.answered = false;
    }

    const question = getCurrentQuestion();
    io.emit('newQuestion', question);

    // Auto-reveal after 30 seconds
    state.questionTimer = setTimeout(() => {
      autoReveal();
    }, state.questionDuration);
  });

  // Player submits answer
  socket.on('submitAnswer', (optionIndex) => {
    const player = state.players.get(socket.id);
    if (!player || player.answered || state.phase !== 'question') return;

    player.answered = true;
    const q = state.questions[state.currentIndex];

    if (optionIndex === q.correctIndex) {
      player.score += 10;
      socket.emit('answerResult', { correct: true, points: 10, score: player.score });
    } else {
      socket.emit('answerResult', { correct: false, points: 0, score: player.score });
    }

    // Notify quizmaster of answer count + live scores
    const answeredCount = Array.from(state.players.values()).filter(p => p.answered).length;
    io.emit('answerProgress', { answered: answeredCount, total: getPlayerCount() });
    io.emit('liveScores', getAllPlayerScores());
  });

  // Quizmaster reveals answer
  socket.on('revealAnswer', () => {
    if (state.currentIndex < 0 || state.currentIndex >= state.questions.length) return;
    if (state.questionTimer) {
      clearTimeout(state.questionTimer);
      state.questionTimer = null;
    }
    state.phase = 'reveal';
    const q = state.questions[state.currentIndex];
    io.emit('answerRevealed', {
      correctIndex: q.correctIndex,
      leaderboard: getLeaderboard().slice(0, 10),
    });
  });

  // Request leaderboard
  socket.on('getLeaderboard', () => {
    socket.emit('leaderboard', getLeaderboard());
  });

  // Reset game
  socket.on('resetGame', () => {
    if (state.questionTimer) {
      clearTimeout(state.questionTimer);
      state.questionTimer = null;
    }
    state.currentIndex = -1;
    state.phase = 'lobby';
    for (const p of state.players.values()) {
      p.score = 0;
      p.answered = false;
    }
    io.emit('gameReset');
  });

  socket.on('disconnect', () => {
    const player = state.players.get(socket.id);
    if (player && player.team) {
      const team = state.teams.get(player.team);
      if (team) {
        team.members = team.members.filter(id => id !== socket.id);
        if (team.members.length === 0) state.teams.delete(player.team);
      }
    }
    state.players.delete(socket.id);
    broadcastPlayerCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Quiz server running on http://localhost:${PORT}`);
  console.log(`Quizmaster panel: http://localhost:${PORT}/master.html`);
  console.log(`Players join at:  http://localhost:${PORT}`);
});
