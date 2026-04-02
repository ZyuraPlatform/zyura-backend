
import http from "http";
import mongoose from "mongoose";
import { Server } from "socket.io";
import app from "./app";
import { configs } from "./app/configs";
import { makeDefaultAdmin } from "./app/utils/makeDefaultAdmin";
import { setupSocket } from "./socket";

let io: Server;

const server = http.createServer(app);
io = new Server(server, {
    cors: {
        origin: ["http://localhost:5173"],
        methods: ["GET", "POST"],                       
        credentials: true,
    },
});

setupSocket(io);

async function main() {
    await mongoose.connect(configs.db_url!);
    server.listen(Number(configs.port), '0.0.0.0', async () => {
        console.log(`Server listening on port ${configs.port}`);
        await makeDefaultAdmin().catch(console.error);
    });
}
main().catch(err => console.log(err));
