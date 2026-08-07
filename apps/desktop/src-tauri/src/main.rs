// the windows release build must not open a console window behind the app
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    carnet_lib::run()
}
