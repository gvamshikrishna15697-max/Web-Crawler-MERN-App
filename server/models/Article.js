import mongoose from "mongoose";

const articleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    source: { type: String, default: "", trim: true },
    locale: { type: String, default: "", trim: true },
    url: { type: String, required: true, unique: true, index: true, trim: true },
    pubDate: { type: Date },
    pubDateText: { type: String, default: "", trim: true },
    /** Publisher metadata enriched from server/config/publications.js. Empty when no match. */
    publisherKey: { type: String, default: "", trim: true, index: true },
    country: { type: String, default: "", trim: true, index: true },
    language: { type: String, default: "", trim: true, index: true },
    category: { type: String, default: "", trim: true, index: true },
  },
  { timestamps: true },
);

articleSchema.index({ pubDate: -1 });
articleSchema.index({ category: 1, pubDate: -1 });
articleSchema.index({ country: 1, pubDate: -1 });

export default mongoose.model("Article", articleSchema);

