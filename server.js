// Local preview only. In production the dashboard is the static `docs/`
// folder served by GitHub Pages — this just lets you look at it locally:
//
//   npm start   ->   http://localhost:4100

const express = require('express');
const path = require('path');

const PORT = Number(process.env.PORT || 4100);
const app = express();

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'docs')));

app.listen(PORT, () => {
  console.log(`Newsletter dashboard preview at http://localhost:${PORT}`);
});
