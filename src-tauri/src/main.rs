// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(any(not(debug_assertions), feature = "custom-protocol"), windows_subsystem = "windows")]

fn main() {
  app_lib::run();
}
