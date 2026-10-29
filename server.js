const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

require("dotenv").config();

const authRouter = require("./routes/auth.routes");
const brSoloFee10Router = require("./routes/brSoloFee10.routes");
const brDuoFee10Router = require("./routes/brDuoFee10.routes");

const app = express();

// HTTP server
const server = http.createServer(app);

// Socket.IO server
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "Server data found",
  });
});

app.use("/auth", authRouter);
app.use("/br-solo-fee10", brSoloFee10Router);
app.use("/br-duo-fee10", brDuoFee10Router);

// Socket.IO connection
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Start server
server.listen(5011, () => {
  console.log("Server running on port... 5011");
});
