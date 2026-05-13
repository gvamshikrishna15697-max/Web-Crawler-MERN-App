import mongoose from "mongoose";

const scrapeRunSchema = new mongoose.Schema(
  {
    trigger: { type: String, enum: ["manual", "cron"], required: true },
    status: { type: String, enum: ["success", "error"], required: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    stats: { type: Object, default: {} },
    snapshot: { type: Object, default: {} },
    error: { type: String, default: "" },
    /** HTTP poll id from POST /api/scrape/run — used to recover status after restart. */
    jobId: { type: String },
  },
  { timestamps: true },
);

scrapeRunSchema.index({ jobId: 1 }, { unique: true, sparse: true });

export default mongoose.model("ScrapeRun", scrapeRunSchema);

