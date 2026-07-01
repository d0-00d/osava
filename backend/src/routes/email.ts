import { Router } from "express";
import { checkEmailBreaches, HIBPError } from "../services/emailService";

const router = Router();

router.get("/api/check-email/:email", async (req, res) => {
  try {
    const result = await checkEmailBreaches(req.params.email);
    res.json(result);
  } catch (error: any) {
    if (error instanceof HIBPError) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
