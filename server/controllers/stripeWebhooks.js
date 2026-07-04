import Stripe from "stripe";
import Booking from "../models/Booking.js";
import Show from "../models/Show.js";

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY);

const releaseBookingSeats = async (booking) => {
    const show = await Show.findById(booking.show)
    if(!show?.occupiedSeats) return;

    booking.bookedSeats.forEach((seat)=>{
        if(show.occupiedSeats[seat] === booking.user){
            delete show.occupiedSeats[seat]
        }
    })

    show.markModified('occupiedSeats')
    await show.save()
}

export const stripeWebhooks = async (req, res)=>{
    const signature = req.headers["stripe-signature"];
    let event;

    if(!process.env.STRIPE_WEBHOOK_SECRET){
        return res.status(500).send("Stripe webhook secret is not configured.");
    }

    try {
        event = getStripe().webhooks.constructEvent(
            req.body,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET
        )
    } catch (error) {
        return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
        if(event.type === "checkout.session.completed"){
            const session = event.data.object;
            const bookingId = session.metadata?.bookingId;

            if(bookingId && session.payment_status === "paid"){
                await Booking.findByIdAndUpdate(bookingId, {
                    $set: {
                        isPaid: true,
                        paymentLink: ""
                    },
                    $unset: {
                        expiresAt: ""
                    }
                })
            }
        }

        if(event.type === "checkout.session.expired"){
            const session = event.data.object;
            const bookingId = session.metadata?.bookingId;
            const booking = bookingId ? await Booking.findById(bookingId) : null;

            if(booking && !booking.isPaid){
                await releaseBookingSeats(booking)
                await Booking.findByIdAndDelete(booking._id)
            }
        }

        res.json({received: true})
    } catch (error) {
        console.error(error.message)
        res.status(500).json({error: error.message})
    }
}
