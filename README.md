# Web Crawler MERN App

A MERN (MongoDB, Express, React, Node) app to **scrape**, **store**, and **search** global publication articles (10k+ records).  
Includes a dashboard to run scrapes, filter stored articles by date range, search by title/locale/source, and paginate results.

## Tech Stack
- **Frontend**: React + Vite
- **Backend**: Node.js + Express
- **Database**: MongoDB (Mongoose)

## Features
- **Scrape jobs**
  - Run **yesterday-only** scrape
  - Run **date-range** scrape (long-running) with **job status polling**
- **Stored articles search**
  - Filter by **published date range**
  - Search **Title**, **Locale**, **Source** (case-insensitive)
  - Pagination with result counts
- **Resilient dev workflow**
  - Server starts even if MongoDB is not connected yet; API returns **503** until DB is ready
  - Scrape job status is designed to survive dev restarts (snapshots + DB fallback)
  - `nodemon` ignores `server/data/**/*` to avoid restarts during snapshot writes
- **Theme**
  - Light / Dark theme toggle
