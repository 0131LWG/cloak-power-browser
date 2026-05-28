import express from 'express';
import {WindowDB} from '/@/db/window';
import {closeFingerprintWindow, openFingerprintWindow} from '/@/fingerprint';

const router = express.Router();

router.get('', async (req, res) => {
  const windows = await WindowDB.all();
  res.send(windows);
});

router.get('/open', async (req, res) => {
  const windowId = Number(req.query.windowId);
  if (!Number.isInteger(windowId) || windowId <= 0) {
    res.status(400).send({error: 'Invalid windowId'});
    return;
  }
  const window = await WindowDB.getById(windowId);
  const result = await openFingerprintWindow(windowId);

  res.send({
    window,
    browser: result,
  });
});

router.get('/close', async (req, res) => {
  const windowId = Number(req.query.windowId);
  if (!Number.isInteger(windowId) || windowId <= 0) {
    res.status(400).send({error: 'Invalid windowId'});
    return;
  }
  const window = await WindowDB.getById(windowId);
  await closeFingerprintWindow(windowId, true);
  res.send({
    window,
  });
});

export default router;
