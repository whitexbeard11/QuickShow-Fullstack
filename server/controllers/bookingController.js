import { clerkClient } from "@clerk/express";
import Stripe from "stripe";
import Booking from "../models/Booking.js";
import Show from "../models/Show.js"
import User from "../models/User.js";

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY);

const releaseExpiredBookings = async (showId) => {
    const expiredBookings = await Booking.find({
        show: showId,
        isPaid: false,
        expiresAt: { $lte: new Date() }
    })

    for (const booking of expiredBookings) {
        const show = await Show.findById(booking.show)
        if(show?.occupiedSeats){
            booking.bookedSeats.forEach((seat)=>{
                if(show.occupiedSeats[seat] === booking.user){
                    delete show.occupiedSeats[seat]
                }
            })
            show.markModified('occupiedSeats')
            await show.save()
        }
        await Booking.findByIdAndDelete(booking._id)
    }
}

// Function to check availability of selected seats for a movie
const checkSeatsAvailability = async (showId, selectedSeats)=>{
    try {
        await releaseExpiredBookings(showId)
        const showData = await Show.findById(showId)
        if(!showData) return false;

        const occupiedSeats = showData.occupiedSeats;

        const isAnySeatTaken = selectedSeats.some(seat => occupiedSeats[seat]);

        return !isAnySeatTaken;
    } catch (error) {
        console.log(error.message);
        return false;
    }
}

export const createBooking = async (req, res)=>{
    let booking;
    let showData;
    try {
        const {userId} = req.auth();
        const {showId, selectedSeats} = req.body;
        const origin = req.headers.origin || process.env.CLIENT_URL || "http://localhost:5173";

        if(!process.env.STRIPE_SECRET_KEY){
            return res.json({success: false, message: "Stripe secret key is not configured."})
        }

        // Check if the seat is available for the selected show
        const isAvailable = await checkSeatsAvailability(showId, selectedSeats)

        if(!isAvailable){
            return res.json({success: false, message: "Selected Seats are not available."})
        }

        // Get the show details
        showData = await Show.findById(showId).populate('movie');

        const clerkUser = await clerkClient.users.getUser(userId);
        await User.findByIdAndUpdate(userId, {
            _id: userId,
            email: clerkUser.emailAddresses[0].emailAddress,
            name: `${clerkUser.firstName || ""} ${clerkUser.lastName || ""}`.trim() || clerkUser.emailAddresses[0].emailAddress,
            image: clerkUser.imageUrl
        }, {upsert: true})

        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

        // Create a new pending booking
        booking = await Booking.create({
            user: userId,
            show: showId,
            amount: showData.showPrice * selectedSeats.length,
            bookedSeats: selectedSeats,
            expiresAt
        })

        selectedSeats.forEach((seat)=>{
            showData.occupiedSeats[seat] = userId;
        })

        showData.markModified('occupiedSeats');

        await showData.save();

        const session = await getStripe().checkout.sessions.create({
            success_url: `${origin}/loading/my-bookings`,
            cancel_url: `${origin}/my-bookings`,
            line_items: [{
                price_data: {
                    currency: process.env.STRIPE_CURRENCY || 'inr',
                    product_data: {
                        name: showData.movie.title
                    },
                    unit_amount: Math.round(booking.amount * 100)
                },
                quantity: 1
            }],
            mode: 'payment',
            metadata: {
                bookingId: booking._id.toString()
            },
            expires_at: Math.floor(expiresAt.getTime() / 1000)
        })

        booking.paymentLink = session.url
        await booking.save()

        res.json({success: true, url: session.url})

    } catch (error) {
        if(booking && !booking.isPaid){
            const show = showData || await Show.findById(booking.show)
            if(show?.occupiedSeats){
                booking.bookedSeats.forEach((seat)=>{
                    if(show.occupiedSeats[seat] === booking.user){
                        delete show.occupiedSeats[seat]
                    }
                })
                show.markModified('occupiedSeats')
                await show.save()
            }
            await Booking.findByIdAndDelete(booking._id)
        }
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}

export const getOccupiedSeats = async (req, res)=>{
    try {
        
        const {showId} = req.params;
        await releaseExpiredBookings(showId)
        const showData = await Show.findById(showId)

        const occupiedSeats = Object.keys(showData.occupiedSeats)

        res.json({success: true, occupiedSeats})

    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}
