import mongoose from "mongoose";

const itemSchema = new mongoose.Schema(
  {
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      default: "",
      maxlength: 1000,
    },
    category: {
      type: String,
      required: true,
      enum: [
        "Snacks",
        "Main Course",
        "Desserts",
        "Pizza",
        "Burgers",
        "Sandwiches",
        "South Indian",
        "North Indian",
        "Chinese",
        "Fast Food",
        "Others",
      ],
    },
    image: {
      type: String, // Image URL
      default: "",
    },
    images: [{
      type: String, // Additional product images
    }],
    availability: {
      type: Boolean,
      default: true,
    },
    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },
    type: {
      type: String,
      enum: ["veg", "non veg"],
    },
    bestSeller: {
      type: Boolean,
      default: false,
    },
    featured: {
      type: Boolean,
      default: false,
    },
    embedding: {
      type: [Number],
      default: undefined,
    },
    vectorIndexedAt: {
      type: Date,
      default: null,
    },
  },

  { timestamps: true }
);

const Item = mongoose.model("Item", itemSchema);
export default Item;
