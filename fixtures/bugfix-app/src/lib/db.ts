import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export interface Book {
  id: string;
  title: string;
  author: string;
  status: "want_to_read" | "reading" | "finished";
  rating?: number;
  createdAt: Date;
  updatedAt: Date;
}
